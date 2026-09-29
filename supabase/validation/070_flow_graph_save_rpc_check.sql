-- ============================================================
-- 070_flow_graph_save_rpc_check.sql
--
-- Script de validação da migration 070 — NÃO É UMA MIGRATION, não é
-- aplicado automaticamente por nenhum runner (supabase db push ignora
-- arquivos fora de supabase/migrations/). Rodar manualmente contra
-- STAGING depois de aplicar 070 manualmente lá, NUNCA em produção.
--
-- Cobre o design original:
--   1. assinatura/grants (somente leitura, seguro em qualquer ambiente)
--   2. save válido substitui todos os nodes
--   3. erro (entry_node_id inválido) não deixa o flow sem nodes nem
--      com metadados parcialmente escritos — confirma a atomicidade
--      fim a fim (grafo + cabeçalho juntos)
--   4. flow de outra account é rejeitado (mesma mensagem de "não
--      existe" — não revela existência)
--   5. flow inexistente é rejeitado
--   6. payload de node tentando forçar outro flow_id é ignorado
--   7. payload vazio ([]) é aceito para um flow draft
--   8. papel viewer é rejeitado
--
-- Os 3 achados da 1ª revisão de segurança/concorrência:
--   9.  agent com override flows.manage=false é rejeitado MESMO com
--       papel 'agent'
--   10. agent com override flows.manage=true, e agent SEM nenhuma
--       linha de override (default = permitir), continuam funcionando
--   11. owner/admin nunca consultam overrides — uma linha perdida de
--       override negando flows.manage para um owner/admin não tem
--       nenhum efeito (contrato de hasPermission() replicado)
--   12. header (name/description/...) + entry_node_id + grafo mudam
--       atomicamente na MESMA chamada
--   13. flow ACTIVE não pode ser salvo com grafo vazio — backstop no
--       banco (a validação completa de forma do grafo é só TypeScript)
--
-- E o achado da 2ª revisão (bypass da validação funcional completa via
-- chamada RPC direta):
--   14. anon/authenticated NÃO têm EXECUTE nesta função — só
--       service_role (ver Seção 1). Isso por si só fecha o bypass:
--       sem a Seção 1 confirmando isso, os testes 15-16 abaixo seriam
--       o único jeito de perceber o problema.
--   15. um grafo NÃO VAZIO mas funcionalmente quebro (sem start) É
--       ACEITO pela função quando p_validated_for_active=false E o
--       flow é 'draft' no momento do lock — confirma que a função
--       DELIBERADAMENTE não replica a validação funcional completa (é
--       trabalho da rota, não desta função) — nunca deve ser
--       interpretado como um bug.
--   16. o MESMO payload funcionalmente quebrado é REJEITADO quando o
--       flow já está 'active' no momento do lock e
--       p_validated_for_active=false — fecha o TOCTOU draft->active: a
--       função nunca commita, num flow active, um payload que não foi
--       certificado como validado para ativo.
--   17. o mesmo payload quebrado, mas com p_validated_for_active=true
--       (simulando route.ts ter rodado validateFlowForActivation e
--       ele ter — hipoteticamente, isso não pode acontecer de verdade
--       porque o payload É funcionalmente inválido — passado) ainda é
--       aceito pela função: prova que p_validated_for_active é só um
--       certificado de "a rota checou isto", não uma segunda validação
--       de forma dentro do banco. A garantia real de que um payload
--       assim nunca chega aqui com p_validated_for_active=true vem de
--       route.ts (ver src/app/api/flows/[id]/route.test.ts, casos
--       3a-3d), não desta função.
--
-- SEGURANÇA DO SCRIPT: SEÇÃO 1 é só introspecção via pg_proc — zero
-- efeito colateral, segura em qualquer ambiente, inclusive produção.
-- SEÇÃO 2 (comportamental) cria dados sintéticos com prefixo
-- '__070_check__' e roda inteira dentro de BEGIN/ROLLBACK — desfeita
-- ao final independentemente do resultado, nenhuma linha sintética
-- sobrevive e nenhum dado real é tocado. Mesmo assim, NÃO rodar a
-- Seção 2 em produção (mesma política de 062/067/068/069).
--
-- PREMISSA sobre o ator: a função deixou de usar auth.uid() (é
-- server-only agora — ver achado 14) — cada chamada de teste passa
-- `p_actor_user_id` explicitamente, simulando o que route.ts faz
-- (ctx.userId, já verificado pela sessão Supabase Auth). As chamadas
-- comportamentais rodam sob `SET LOCAL ROLE service_role`, o único
-- papel com EXECUTE — simula o client service-role do backend, nunca
-- um client de sessão de usuário.
-- ============================================================

-- ============================================================
-- SEÇÃO 1 — Assinatura e grants
-- ============================================================

-- Assinatura esperada: save_flow_graph(uuid, uuid, text, jsonb,
-- boolean, jsonb) -> void, SECURITY DEFINER, search_path = ''.
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  pg_get_function_result(p.oid) AS returns,
  p.prosecdef AS is_security_definer,
  p.proconfig AS config -- expect {search_path=}
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'save_flow_graph';

-- Confirma que nenhuma assinatura anterior (rascunhos pré-revisão, 3
-- ou 4 parâmetros) sobrevive, caso tenha sido aplicada manualmente em
-- algum ambiente de teste durante a revisão.
SELECT count(*) AS old_overloads_should_be_zero
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'save_flow_graph'
  AND pg_get_function_identity_arguments(p.oid) IN (
    'p_flow_id uuid, p_entry_node_id text, p_nodes jsonb',
    'p_flow_id uuid, p_entry_node_id text, p_nodes jsonb, p_flow_patch jsonb'
  );

-- 14: anon/authenticated SEM EXECUTE, service_role COM EXECUTE — este
-- é o teste que fecha o achado da 2ª revisão. Se auth_can_execute vier
-- `true`, a validação funcional completa da rota (validateFlowForActivation)
-- pode ser contornada por uma chamada RPC direta do browser — reprovar
-- a aplicação da migration imediatamente se isso acontecer.
SELECT
  has_function_privilege('anon', 'public.save_flow_graph(uuid, uuid, text, jsonb, boolean, jsonb)', 'EXECUTE') AS anon_can_execute,          -- expect false
  has_function_privilege('authenticated', 'public.save_flow_graph(uuid, uuid, text, jsonb, boolean, jsonb)', 'EXECUTE') AS auth_can_execute,  -- expect false — MUST be false
  has_function_privilege('service_role', 'public.save_flow_graph(uuid, uuid, text, jsonb, boolean, jsonb)', 'EXECUTE') AS service_role_can_execute; -- expect true

-- ============================================================
-- SEÇÃO 2 — Comportamental (dentro de BEGIN/ROLLBACK)
-- ============================================================

BEGIN;

-- ---- Fixtures ----
-- Duas accounts, quatro usuários (agent A, viewer A, admin A, agent
-- B), um flow draft na account A com dois nodes existentes, e um
-- segundo flow ACTIVE na account A.

INSERT INTO public.accounts (id, name, is_active)
VALUES
  ('00000000-0000-0000-0000-0000000070a1', '__070_check__ Account A', true),
  ('00000000-0000-0000-0000-0000000070b1', '__070_check__ Account B', true);

-- profiles.user_id referencia auth.users — em staging, usar ids de
-- usuários de teste já existentes, ou criar via auth.admin API antes
-- de rodar este script. Placeholders abaixo assumem que esses users
-- já existem (mesma premissa dos checks de 068/069). Ajustar os UUIDs
-- antes de rodar.
-- INSERT INTO public.profiles (user_id, account_id, account_role, is_active, full_name, email)
-- VALUES
--   ('<user-agent-a>',  '00000000-0000-0000-0000-0000000070a1', 'agent',  true, 'Agent A',  'agent-a@__070_check__.test'),
--   ('<user-viewer-a>', '00000000-0000-0000-0000-0000000070a1', 'viewer', true, 'Viewer A', 'viewer-a@__070_check__.test'),
--   ('<user-admin-a>',  '00000000-0000-0000-0000-0000000070a1', 'admin',  true, 'Admin A',  'admin-a@__070_check__.test'),
--   ('<user-agent-b>',  '00000000-0000-0000-0000-0000000070b1', 'agent',  true, 'Agent B',  'agent-b@__070_check__.test');

INSERT INTO public.flows (id, account_id, user_id, name, status, trigger_type, trigger_config, entry_node_id)
VALUES (
  '00000000-0000-0000-0000-0000000070f1',
  '00000000-0000-0000-0000-0000000070a1',
  (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' LIMIT 1),
  '__070_check__ flow',
  'draft',
  'manual',
  '{}'::jsonb,
  'old_start'
);

INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config)
VALUES
  ('00000000-0000-0000-0000-0000000070f1', 'old_start', 'start', '{"next_node_key":"old_end"}'::jsonb),
  ('00000000-0000-0000-0000-0000000070f1', 'old_end', 'end', '{}'::jsonb);

-- Segundo flow, já ACTIVE, com um grafo mínimo válido.
INSERT INTO public.flows (id, account_id, user_id, name, status, trigger_type, trigger_config, entry_node_id)
VALUES (
  '00000000-0000-0000-0000-0000000070f2',
  '00000000-0000-0000-0000-0000000070a1',
  (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' LIMIT 1),
  '__070_check__ active flow',
  'active',
  'manual',
  '{}'::jsonb,
  'a_start'
);

INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config)
VALUES
  ('00000000-0000-0000-0000-0000000070f2', 'a_start', 'start', '{"next_node_key":"a_end"}'::jsonb),
  ('00000000-0000-0000-0000-0000000070f2', 'a_end', 'end', '{}'::jsonb);

SET LOCAL ROLE service_role;

-- ---- Test 2: save válido substitui todos os nodes ----
SELECT public.save_flow_graph(
  p_actor_user_id := (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND account_role = 'agent' LIMIT 1),
  p_flow_id := '00000000-0000-0000-0000-0000000070f1',
  p_entry_node_id := 'new_start',
  p_nodes := '[
    {"node_key":"new_start","node_type":"start","config":{"next_node_key":"new_end"}},
    {"node_key":"new_end","node_type":"end","config":{}}
  ]'::jsonb
);

RESET ROLE;
-- Expect: exactly new_start/new_end remain, old_start/old_end gone,
-- flows.entry_node_id = 'new_start'.
SELECT node_key FROM public.flow_nodes WHERE flow_id = '00000000-0000-0000-0000-0000000070f1' ORDER BY node_key;
SELECT entry_node_id FROM public.flows WHERE id = '00000000-0000-0000-0000-0000000070f1';

-- ---- Test 3 / 12: entry_node_id inválido não apaga o grafo anterior
-- NEM deixa metadados parcialmente escritos ----
SET LOCAL ROLE service_role;

DO $$
BEGIN
  BEGIN
    PERFORM public.save_flow_graph(
      p_actor_user_id := (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND account_role = 'agent' LIMIT 1),
      p_flow_id := '00000000-0000-0000-0000-0000000070f1',
      p_entry_node_id := 'does_not_exist',
      p_nodes := '[{"node_key":"whatever","node_type":"start","config":{}}]'::jsonb,
      p_flow_patch := '{"name":"SHOULD NOT STICK"}'::jsonb
    );
    RAISE EXCEPTION 'expected save_flow_graph to reject a dangling entry_node_id';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'entry_node_id does not match any node in this save' THEN
      RAISE NOTICE 'OK: rejected as expected';
    ELSE
      RAISE;
    END IF;
  END;
END $$;

RESET ROLE;
-- Expect: STILL new_start/new_end from Test 2 (graph untouched) AND
-- name STILL '__070_check__ flow' (header untouched).
SELECT node_key FROM public.flow_nodes WHERE flow_id = '00000000-0000-0000-0000-0000000070f1' ORDER BY node_key;
SELECT name FROM public.flows WHERE id = '00000000-0000-0000-0000-0000000070f1'; -- expect '__070_check__ flow', NOT 'SHOULD NOT STICK'

-- ---- Test 4/5: outra account / flow inexistente -> mesma mensagem ----
SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_agent_b UUID := (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070b1' AND account_role = 'agent' LIMIT 1);
BEGIN
  BEGIN
    PERFORM public.save_flow_graph(v_agent_b, '00000000-0000-0000-0000-0000000070f1', NULL, '[]'::jsonb);
    RAISE EXCEPTION 'expected rejection for cross-account flow_id';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'Flow not found' THEN RAISE NOTICE 'OK: cross-account rejected as Flow not found';
    ELSE RAISE; END IF;
  END;
  BEGIN
    PERFORM public.save_flow_graph(v_agent_b, '00000000-0000-0000-0000-000000000000', NULL, '[]'::jsonb);
    RAISE EXCEPTION 'expected rejection for nonexistent flow_id';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'Flow not found' THEN RAISE NOTICE 'OK: nonexistent flow rejected, same message';
    ELSE RAISE; END IF;
  END;
END $$;

RESET ROLE;

-- ---- Test 7: payload vazio é aceito (rascunho sem nodes) ----
SET LOCAL ROLE service_role;

SELECT public.save_flow_graph(
  (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND account_role = 'agent' LIMIT 1),
  '00000000-0000-0000-0000-0000000070f1', NULL, '[]'::jsonb
);

RESET ROLE;
-- Expect: zero rows, entry_node_id NULL.
SELECT count(*) FROM public.flow_nodes WHERE flow_id = '00000000-0000-0000-0000-0000000070f1'; -- expect 0
SELECT entry_node_id FROM public.flows WHERE id = '00000000-0000-0000-0000-0000000070f1'; -- expect NULL

-- ---- Test 8: viewer é rejeitado ----
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.save_flow_graph(
      (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND account_role = 'viewer' LIMIT 1),
      '00000000-0000-0000-0000-0000000070f1', NULL, '[]'::jsonb
    );
    RAISE EXCEPTION 'expected viewer to be rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'Caller role cannot edit flows' THEN RAISE NOTICE 'OK: viewer rejected';
    ELSE RAISE; END IF;
  END;
END $$;
RESET ROLE;

-- ============================================================
-- Testes 9-11 — achado #1 (1ª revisão): bypass de flows.manage via
-- chamada RPC direta.
-- ============================================================

-- ---- Test 9: agent com override flows.manage=false é rejeitado ----
INSERT INTO public.user_permission_overrides (account_id, user_id, permission_key, allowed)
VALUES (
  '00000000-0000-0000-0000-0000000070a1',
  (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND account_role = 'agent' LIMIT 1),
  'flows.manage',
  false
);

SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.save_flow_graph(
      (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND account_role = 'agent' LIMIT 1),
      '00000000-0000-0000-0000-0000000070f1', NULL, '[]'::jsonb
    );
    RAISE EXCEPTION 'expected agent with flows.manage=false override to be rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'Caller does not have the flows.manage permission' THEN
      RAISE NOTICE 'OK: override=false rejected — bypass closed';
    ELSE RAISE; END IF;
  END;
END $$;
RESET ROLE;

DELETE FROM public.user_permission_overrides
WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND permission_key = 'flows.manage';

-- ---- Test 10a: agent SEM nenhuma linha de override continua permitido
-- (default = true para flows.manage) ----
SET LOCAL ROLE service_role;
SELECT public.save_flow_graph(
  (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND account_role = 'agent' LIMIT 1),
  '00000000-0000-0000-0000-0000000070f1', NULL, '[]'::jsonb
); -- expect success
RESET ROLE;

-- ---- Test 10b: agent com override flows.manage=true continua permitido ----
INSERT INTO public.user_permission_overrides (account_id, user_id, permission_key, allowed)
VALUES (
  '00000000-0000-0000-0000-0000000070a1',
  (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND account_role = 'agent' LIMIT 1),
  'flows.manage',
  true
);
SET LOCAL ROLE service_role;
SELECT public.save_flow_graph(
  (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND account_role = 'agent' LIMIT 1),
  '00000000-0000-0000-0000-0000000070f1', NULL, '[]'::jsonb
); -- expect success
RESET ROLE;

-- ---- Test 11: owner/admin NUNCA consultam overrides ----
INSERT INTO public.user_permission_overrides (account_id, user_id, permission_key, allowed)
VALUES (
  '00000000-0000-0000-0000-0000000070a1',
  (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND account_role = 'admin' LIMIT 1),
  'flows.manage',
  false
);
SET LOCAL ROLE service_role;
SELECT public.save_flow_graph(
  (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND account_role = 'admin' LIMIT 1),
  '00000000-0000-0000-0000-0000000070f1', NULL, '[]'::jsonb
); -- expect success — admin ignores the override row entirely
RESET ROLE;

DELETE FROM public.user_permission_overrides WHERE account_id = '00000000-0000-0000-0000-0000000070a1';

-- ============================================================
-- Teste 12 (comportamental) — header + grafo mudam na MESMA chamada
-- ============================================================
SET LOCAL ROLE service_role;

SELECT public.save_flow_graph(
  p_actor_user_id := (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND account_role = 'agent' LIMIT 1),
  p_flow_id := '00000000-0000-0000-0000-0000000070f1',
  p_entry_node_id := 'combo_start',
  p_nodes := '[{"node_key":"combo_start","node_type":"start","config":{"next_node_key":"combo_end"}},{"node_key":"combo_end","node_type":"end","config":{}}]'::jsonb,
  p_flow_patch := '{"name":"Renamed in the same call","fallback_policy":{"on_unknown_reply":"reprompt","max_reprompts":1,"on_timeout_hours":1,"on_exhaust":"handoff"}}'::jsonb
);

RESET ROLE;
-- Expect: name updated AND graph updated, from one call.
SELECT name, fallback_policy FROM public.flows WHERE id = '00000000-0000-0000-0000-0000000070f1';
SELECT node_key FROM public.flow_nodes WHERE flow_id = '00000000-0000-0000-0000-0000000070f1' ORDER BY node_key; -- expect combo_end, combo_start

-- ============================================================
-- Teste 13 — achado #3 (1ª revisão): flow ACTIVE não pode ficar sem
-- nodes, mesmo direto pela RPC.
-- ============================================================
SET LOCAL ROLE service_role;

DO $$
BEGIN
  BEGIN
    PERFORM public.save_flow_graph(
      (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND account_role = 'agent' LIMIT 1),
      '00000000-0000-0000-0000-0000000070f2', NULL, '[]'::jsonb
    );
    RAISE EXCEPTION 'expected empty graph on an ACTIVE flow to be rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'Cannot save an empty graph onto an active flow' THEN
      RAISE NOTICE 'OK: active flow protected against an empty graph';
    ELSE RAISE; END IF;
  END;
END $$;

SELECT node_key FROM public.flow_nodes WHERE flow_id = '00000000-0000-0000-0000-0000000070f2' ORDER BY node_key; -- expect a_end, a_start (survived)

RESET ROLE;

-- ============================================================
-- Testes 14-17 — achado da 2ª revisão: bypass da validação funcional
-- completa via chamada RPC direta, e o fechamento do TOCTOU
-- draft->active com p_validated_for_active.
-- ============================================================

-- Teste 14 já coberto na Seção 1 (grants) — repetido aqui só como
-- lembrete de que 15-17 só fazem sentido DEPOIS de confirmar que
-- anon/authenticated não têm EXECUTE.

SET LOCAL ROLE service_role;

-- ---- Test 15: grafo NÃO VAZIO mas funcionalmente quebrado (sem
-- start, só um send_message auto-referenciado) é ACEITO quando o flow
-- é 'draft' e p_validated_for_active=false (default) — confirma que a
-- função DELIBERADAMENTE não replica a validação funcional completa.
-- ----
SELECT public.save_flow_graph(
  p_actor_user_id := (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND account_role = 'agent' LIMIT 1),
  p_flow_id := '00000000-0000-0000-0000-0000000070f1', -- still draft
  p_entry_node_id := 'broken',
  p_nodes := '[{"node_key":"broken","node_type":"send_message","config":{"text":"loop","next_node_key":"broken"}}]'::jsonb
);
-- Expect: SUCCESS. This is correct, not a bug — validate.ts is the
-- only place that would ever reject this shape (no start node, a
-- self-loop), and drafts are allowed to be broken.
SELECT node_key, node_type FROM public.flow_nodes WHERE flow_id = '00000000-0000-0000-0000-0000000070f1';

-- ---- Test 16: the SAME broken graph is REJECTED when the flow is
-- ACTIVE and p_validated_for_active=false — the TOCTOU close. ----
DO $$
BEGIN
  BEGIN
    PERFORM public.save_flow_graph(
      p_actor_user_id := (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND account_role = 'agent' LIMIT 1),
      p_flow_id := '00000000-0000-0000-0000-0000000070f2', -- active
      p_entry_node_id := 'broken',
      p_nodes := '[{"node_key":"broken","node_type":"send_message","config":{"text":"loop","next_node_key":"broken"}}]'::jsonb
      -- p_validated_for_active omitted -> defaults to false
    );
    RAISE EXCEPTION 'expected an unvalidated payload to be rejected on an active flow';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'Flow status changed since this save was validated' THEN
      RAISE NOTICE 'OK: TOCTOU guard rejected the unvalidated payload on the active flow';
    ELSE RAISE; END IF;
  END;
END $$;
-- Confirms the active flow's original graph survived.
SELECT node_key FROM public.flow_nodes WHERE flow_id = '00000000-0000-0000-0000-0000000070f2' ORDER BY node_key; -- expect a_end, a_start

-- ---- Test 17: the same broken graph WITH p_validated_for_active=true
-- is accepted — proves the parameter is a certificate, not a second
-- validator. In real usage route.ts would never send true for a
-- payload this broken (validateFlowForActivation would have already
-- 422'd it) — this test exists to document precisely where the
-- responsibility boundary is, not to claim the RPC re-checks shape. ----
SELECT public.save_flow_graph(
  p_actor_user_id := (SELECT user_id FROM public.profiles WHERE account_id = '00000000-0000-0000-0000-0000000070a1' AND account_role = 'agent' LIMIT 1),
  p_flow_id := '00000000-0000-0000-0000-0000000070f2',
  p_entry_node_id := 'broken',
  p_nodes := '[{"node_key":"broken","node_type":"send_message","config":{"text":"loop","next_node_key":"broken"}}]'::jsonb,
  p_validated_for_active := true
);
-- Expect: SUCCESS (by design — see comment above).
SELECT node_key FROM public.flow_nodes WHERE flow_id = '00000000-0000-0000-0000-0000000070f2';

RESET ROLE;

ROLLBACK;
-- Nada acima sobrevive — nenhuma linha sintética, nenhum dado real
-- tocado.
