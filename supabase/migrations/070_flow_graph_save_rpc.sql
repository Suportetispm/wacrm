-- ============================================================
-- 070_flow_graph_save_rpc
--
-- FASE 1A.2A — Save transacional do Flow (auditoria aprovada na Fase
-- 1A.1 — ver WACRM_ESTADO_ATUAL.md, seção "Análise de save/
-- versionamento"). Corrige o risco original:
--
--   PUT /api/flows/[id] (src/app/api/flows/[id]/route.ts) replaces the
--   node graph as two SEPARATE PostgREST calls — DELETE flow_nodes
--   WHERE flow_id=... followed by INSERT flow_nodes (...) — with no
--   transaction spanning them. If the INSERT fails (bad payload,
--   constraint violation, connection drop) AFTER the DELETE already
--   committed, the flow is left with ZERO nodes until the next
--   successful save.
--
-- REVISADA DUAS VEZES (revisões de segurança/concorrência pós-primeira
-- versão, mesma sessão) para fechar 4 achados no total:
--
--   1. BYPASS DE flows.manage — a versão original só checava
--      account_role IN ('owner','admin','agent'), nunca o override por
--      usuário de user_permission_overrides (062). CORRIGIDO na
--      revisão 1: a função passou a ler user_permission_overrides
--      diretamente (nunca agent_has_permission_override() — ver
--      comentário no corpo da função).
--
--   2. METADADOS + GRAFO NÃO ATÔMICOS ENTRE SI — a rota fazia um UPDATE
--      simples do cabeçalho e SÓ DEPOIS chamava esta RPC — duas
--      transações separadas. CORRIGIDO na revisão 1: p_flow_patch
--      (JSONB) escreve cabeçalho + entry_node_id + grafo na MESMA
--      transação protegida pelo FOR UPDATE.
--
--   3. FLOW ACTIVE PODIA SER SALVO SEM NODES — nada impedia p_nodes=[]
--      num flow 'active'. CORRIGIDO na revisão 1: backstop mínimo
--      dentro do lock (grafo vazio nunca commita num flow active),
--      complementando a validação completa que passou a rodar em
--      TypeScript (route.ts chama validateFlowForActivation quando o
--      flow já é 'active').
--
--   4. BYPASS DA VALIDAÇÃO FUNCIONAL COMPLETA (esta revisão) — mesmo
--      com 1-3 corrigidos, a função ainda tinha
--      `GRANT EXECUTE TO authenticated`. Um usuário com flows.manage
--      LEGÍTIMO (sem nenhuma negação de override) podia chamar
--      `supabase.rpc('save_flow_graph', ...)` DIRETO do browser contra
--      um flow 'active', com um grafo NÃO VAZIO mas funcionalmente
--      quebrado — sem start, sem entry coerente, com ciclo
--      auto-advancing, com nodes inalcançáveis, com config inválida —
--      qualquer coisa que validateFlowForActivation (TypeScript,
--      src/lib/flows/validate.ts) barraria, mas que o backstop do
--      achado 3 (só checa array vazio) nunca pegava. Isso é um bypass
--      real da rota, não hipotético: a validação funcional completa do
--      grafo SÓ existe em route.ts, e route.ts é só um caminho
--      opcional até esta RPC enquanto ela aceitar chamadas diretas de
--      `authenticated`.
--
--      CORRIGIDO nesta revisão com a mudança estrutural pedida: a
--      função deixou de ser chamável por `authenticated` inteiramente.
--      Passou a exigir `service_role` — mesmo padrão já usado neste
--      projeto para claim_ai_reply_slot / record_webhook_failure /
--      recompute_broadcast_counts (067_security_definer_hardening.sql:
--      "REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE
--      ... TO service_role"). Como só o backend confiável (o client
--      service-role do Next.js, nunca exposto ao browser) pode chamar
--      esta função, e o backend SEMPRE roda validateFlowForActivation
--      antes de chamar quando o flow está active, o bypass fica
--      estruturalmente impossível — não é mais "ninguém deveria
--      chamar direto", é "ninguém CONSEGUE chamar direto".
--
--      Consequência: a função não pode mais usar `auth.uid()` para
--      saber quem está chamando (service_role não carrega JWT de
--      usuário) — ganhou o parâmetro `p_actor_user_id UUID`, que a
--      rota preenche com o id já verificado por
--      requirePermission()/getCurrentAccount() (sessão Supabase Auth
--      validada server-side via cookie, nunca um valor vindo do corpo
--      da requisição HTTP). A função CONTINUA revalidando role/
--      is_active/tenancy/override a partir desse id contra profiles/
--      accounts/user_permission_overrides — nunca aceita um papel ou
--      account_id prontos vindos de fora, só o id do ator, do mesmo
--      jeito que as RPCs de ticket (068) fariam se fossem chamadas via
--      service_role com um p_caller_id.
--
--      TOCTOU draft->active fechado com um novo parâmetro,
--      `p_validated_for_active BOOLEAN DEFAULT false`: a rota só o
--      marca `true` quando LEU o flow como 'active' E rodou
--      validateFlowForActivation contra este payload exato e ele
--      passou. Dentro do lock, se o flow está REALMENTE 'active' e
--      `p_validated_for_active` não é true, a função rejeita com um
--      erro reconhecível (a rota mapeia para HTTP 409 — "tente de
--      novo", nunca commita) — fecha a janela entre a rota ler
--      status='draft' (sem rodar o validador) e outra requisição
--      ativar o flow antes do lock desta chamada.
--
-- ESCOPO (ainda estritamente este): uma única função,
-- `save_flow_graph`, que substitui o grafo + atualiza entry_node_id +
-- os campos de cabeçalho do flow, tudo em uma transação. Nada de
-- flow_versions/rollback/snapshot — isso é Fase 1A.2B. Um run ativo
-- lendo `flow_nodes` no meio de um save continua sujeito ao mesmo
-- comportamento de hoje (node_not_found termina o run com segurança) —
-- não resolvido aqui, documentado como risco residual.
--
-- POR QUE UMA FUNÇÃO NOVA, NÃO EDITAR NENHUMA EXISTENTE: não existe
-- nenhuma função "save do grafo de flow" hoje. Esta migration não toca
-- 062, 068 nem 069 — só LÊ a tabela que 062 cria (user_permission_
-- overrides), nunca redefine nada dessas migrations.
--
-- DIVISÃO DE RESPONSABILIDADE (TypeScript vs Postgres) — inalterada:
--   TypeScript (src/lib/flows/validate.ts) continua o ÚNICO lugar que
--   valida a FORMA funcional do grafo: exactly-one-start, cycle
--   detection, reachability, campos por node_type, limites Meta. Nada
--   disso duplicado em SQL — e agora estruturalmente inescapável, não
--   só "a rota de costume".
--   Postgres/RPC garante tenancy, o piso de papel + a permissão
--   granular efetiva de 'flows.manage' (a partir do ator identificado
--   pela API), atomicidade da substituição (grafo + cabeçalho juntos),
--   que entry_node_id nunca aponta para um node ausente do grafo
--   recém-salvo, o backstop de grafo vazio em flow active, e o
--   fechamento do TOCTOU draft->active via p_validated_for_active.
--   Rascunhos/arquivados incompletos continuam salváveis sem
--   restrição.
--
-- SECURITY DEFINER — mantido por defesa em profundidade (SET
-- search_path = '' + toda tabela/tipo schema-qualificado, mesmo padrão
-- de 052/065/066/067) mesmo agora que só service_role chama esta
-- função: service_role já tem BYPASSRLS no Supabase, então SECURITY
-- DEFINER deixou de ser estritamente necessário para o acesso às
-- tabelas, mas continua sendo a convenção do projeto para toda função
-- deste tipo (mesmo claim_ai_reply_slot, só chamada por service_role,
-- permanece SECURITY DEFINER) — muda o modelo de ameaça de "impedir
-- que authenticated explore a função" para "nada muda no acesso a
-- dados, já que o único chamador possível já bypassa RLS de qualquer
-- forma".
--
-- Idempotente — CREATE OR REPLACE FUNCTION substitui o corpo inteiro;
-- REVOKE/GRANT são no-op quando já aplicados. Os DROP FUNCTION abaixo
-- cobrem a possibilidade de alguma assinatura anterior (3 ou 4
-- parâmetros, das revisões passadas desta mesma migration ainda não
-- aplicada) ter sido colada manualmente num ambiente de teste durante
-- a revisão — nunca aplicada em staging/produção reais até agora, mas
-- os DROPs tornam o reapply seguro de qualquer jeito.
--
-- NÃO APLICADA nesta etapa — revisão manual pendente antes de rodar
-- contra staging/produção. Script de validação separado em
-- supabase/validation/070_flow_graph_save_rpc_check.sql (não faz
-- parte desta migration, não é aplicado por ela).
-- ============================================================

DROP FUNCTION IF EXISTS public.save_flow_graph(UUID, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.save_flow_graph(UUID, TEXT, JSONB, JSONB);

CREATE OR REPLACE FUNCTION public.save_flow_graph(
  p_actor_user_id UUID,
  p_flow_id UUID,
  p_entry_node_id TEXT,
  p_nodes JSONB,
  p_validated_for_active BOOLEAN DEFAULT false,
  p_flow_patch JSONB DEFAULT '{}'::jsonb
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID := p_actor_user_id;
  v_caller_account_id UUID;
  v_caller_role public.account_role_enum;
  v_caller_active BOOLEAN;
  v_account_active BOOLEAN;
  v_override_allowed BOOLEAN;
  v_flow_locked UUID;
  v_flow_status TEXT;
  v_entry_match_count INTEGER;
BEGIN
  -- This function is server-only (see grants at the bottom) — the
  -- only caller is src/app/api/flows/[id]/route.ts's PUT handler,
  -- using the service-role admin client. p_actor_user_id is NOT a
  -- value read from the HTTP request body — it's ctx.userId from
  -- requirePermission('flows.manage') (src/lib/auth/permission-guard.ts),
  -- which itself comes from getCurrentAccount() calling Supabase
  -- Auth's own server-side session verification
  -- (supabase.auth.getUser() against the request's cookie, via
  -- @/lib/supabase/server). A compromised/malicious HTTP body can
  -- never influence this value — only a genuinely authenticated
  -- session can. Everything below still re-derives role/tenancy/
  -- override from THIS id against profiles/accounts/
  -- user_permission_overrides — the id is trusted as "who is asking",
  -- never as "what they're allowed to do".
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id, p.account_role, p.is_active, a.is_active
    INTO v_caller_account_id, v_caller_role, v_caller_active, v_account_active
  FROM public.profiles p
  JOIN public.accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF NOT v_caller_active THEN
    RAISE EXCEPTION 'Caller is not active' USING ERRCODE = '42501';
  END IF;
  IF NOT v_account_active THEN
    RAISE EXCEPTION 'Account is not active' USING ERRCODE = '42501';
  END IF;
  -- Same floor as the flows_update / flow_nodes_modify RLS policies
  -- (is_account_member(account_id, 'agent')) — viewer can never edit
  -- flows, with or without any override row (hasPermission() in
  -- permission-guard.ts never even consults overrides for a non-agent
  -- role — see the block right below for why that matters here too).
  IF v_caller_role NOT IN ('owner', 'admin', 'agent') THEN
    RAISE EXCEPTION 'Caller role cannot edit flows' USING ERRCODE = '42501';
  END IF;

  -- Fine-grained per-agent override (062, user_permission_overrides).
  -- Deliberately NOT reusing public.agent_has_permission_override()
  -- (062): that helper hardcodes "row absent -> false", correct ONLY
  -- for the two administrative keys it was built to serve
  -- (users.create / users.edit — both default false in
  -- src/lib/auth/permissions.ts). 'flows.manage' defaults true —
  -- reusing that helper as-is would block every agent who has never
  -- had an override configured. This reads the SAME underlying table
  -- with the correct default for THIS key, mirroring hasPermission()'s
  -- actual formula for it: `override ?? true`.
  --
  -- owner/admin never reach this block (hasPermission():
  -- `role !== 'agent' -> legacyHasPermission`, always true for them on
  -- 'flows.manage') — matches the unconditional pass already given to
  -- them above. viewer was already rejected above — confirms no role
  -- below agent can ever legitimately receive flows.manage via
  -- override (hasPermission() only consults overrides when
  -- ctx.role === 'agent').
  IF v_caller_role = 'agent' THEN
    SELECT allowed INTO v_override_allowed
    FROM public.user_permission_overrides
    WHERE account_id = v_caller_account_id
      AND user_id = v_caller_id
      AND permission_key = 'flows.manage';
    IF COALESCE(v_override_allowed, true) = false THEN
      RAISE EXCEPTION 'Caller does not have the flows.manage permission' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_flow_id IS NULL THEN
    RAISE EXCEPTION 'flow_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_nodes IS NULL OR jsonb_typeof(p_nodes) <> 'array' THEN
    RAISE EXCEPTION 'nodes must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF p_flow_patch IS NULL OR jsonb_typeof(p_flow_patch) <> 'object' THEN
    RAISE EXCEPTION 'flow_patch must be a JSON object' USING ERRCODE = '22023';
  END IF;

  -- Tenancy + row lock in one step, same shape as claim_ticket /
  -- transfer_ticket_agent / transfer_ticket_queue (068): folding
  -- "exists" and "belongs to this account" into a single WHERE means a
  -- cross-tenant flow_id and a nonexistent flow_id raise the exact
  -- same error — never confirms existence of another account's flow.
  --
  -- FOR UPDATE serializes concurrent saves of the SAME flow: a second
  -- overlapping call blocks here until the first transaction commits
  -- or rolls back, then re-evaluates against the now-committed state.
  -- The lock protects the FULL save (header fields + entry_node_id +
  -- graph, all written below in this same transaction) — a plain row
  -- lock on the parent `flows` row is sufficient: the only
  -- cross-request invariant that matters is "never let two saves'
  -- writes interleave", and mutual exclusion on the one row both saves
  -- target already guarantees that.
  SELECT id, status INTO v_flow_locked, v_flow_status
  FROM public.flows
  WHERE id = p_flow_id AND account_id = v_caller_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flow not found' USING ERRCODE = '22023';
  END IF;

  -- Nothing stopped an already-'active' flow (serving real customers)
  -- from being saved with zero nodes. Unconditional backstop,
  -- regardless of p_validated_for_active — cheap, and correct even if
  -- that flag were ever computed wrong upstream.
  IF v_flow_status = 'active' AND jsonb_array_length(p_nodes) = 0 THEN
    RAISE EXCEPTION 'Cannot save an empty graph onto an active flow' USING ERRCODE = '22023';
  END IF;

  -- TOCTOU close: route.ts reads the flow's status, runs the full
  -- validateFlowForActivation validator ONLY when that read says
  -- 'active', and passes p_validated_for_active = true only when that
  -- validator ran against THIS exact payload and found zero blocking
  -- issues. If between that read and this lock another request
  -- activated the flow, v_flow_status is 'active' here but
  -- p_validated_for_active is still false (this payload was only ever
  -- checked as a draft, i.e. not checked at all) — reject rather than
  -- silently commit a graph that was never confirmed safe for an
  -- active flow. route.ts maps this specific message to HTTP 409 so
  -- the client can reload the flow's current state and retry (no
  -- automatic retry loop here — the simplest safe behavior per the
  -- review's own request). A flow that was 'active' when validated and
  -- is no longer active by lock time needs no such guard — a payload
  -- that already passed the strict activation rules is trivially valid
  -- for a less-restrictive draft/archived state too.
  IF v_flow_status = 'active' AND NOT p_validated_for_active THEN
    RAISE EXCEPTION 'Flow status changed since this save was validated' USING ERRCODE = '40001';
  END IF;

  -- Replace the graph. flow_id is forced from the already-validated
  -- p_flow_id — nothing in p_nodes' own JSON shape is ever read as
  -- "which flow"/"which account" this node belongs to; a node can
  -- never force itself onto another flow or account.
  DELETE FROM public.flow_nodes WHERE flow_id = p_flow_id;

  INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config, position_x, position_y)
  SELECT
    p_flow_id,
    x.node_key,
    x.node_type,
    COALESCE(x.config, '{}'::jsonb),
    COALESCE(x.position_x, 0),
    COALESCE(x.position_y, 0)
  FROM jsonb_to_recordset(p_nodes) AS x(
    node_key TEXT,
    node_type TEXT,
    config JSONB,
    position_x INTEGER,
    position_y INTEGER
  );
  -- Deliberately NOT re-validated here beyond what the table's own
  -- constraints already enforce: flow_nodes.node_key/node_type NOT
  -- NULL (010), flow_nodes_node_type_check (060), UNIQUE(flow_id,
  -- node_key) (010). Any violation raises here and the whole function
  -- aborts — the DELETE above and everything else this call did is
  -- undone by ordinary Postgres transaction semantics. Full functional
  -- shape validation (exactly-one-start, cycles, reachability,
  -- per-node-type fields) is NEVER duplicated here — it's guaranteed
  -- by construction instead, since this function has no caller other
  -- than route.ts (see grants).

  -- The one graph-shape invariant this layer owns directly:
  -- entry_node_id must reference a node_key that exists in the graph
  -- we just wrote, or be NULL.
  IF p_entry_node_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_entry_match_count
    FROM public.flow_nodes
    WHERE flow_id = p_flow_id AND node_key = p_entry_node_id;
    IF v_entry_match_count = 0 THEN
      RAISE EXCEPTION 'entry_node_id does not match any node in this save' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Header fields, in the SAME locked transaction as the graph. The
  -- `?` (jsonb "has key") operator per field distinguishes "caller
  -- provided this field in p_flow_patch" (write it, even when the
  -- value itself is JSON null — e.g. clearing description) from
  -- "caller omitted it" (leave the column untouched) — without a
  -- second SELECT to merge current values and without dynamic SQL.
  -- entry_node_id is unconditional (not gated by `?`) because
  -- p_entry_node_id is its own required parameter, always meaningful
  -- together with p_nodes.
  UPDATE public.flows
  SET
    name = CASE WHEN p_flow_patch ? 'name' THEN p_flow_patch->>'name' ELSE name END,
    description = CASE WHEN p_flow_patch ? 'description' THEN p_flow_patch->>'description' ELSE description END,
    trigger_type = CASE WHEN p_flow_patch ? 'trigger_type' THEN p_flow_patch->>'trigger_type' ELSE trigger_type END,
    trigger_config = CASE WHEN p_flow_patch ? 'trigger_config' THEN p_flow_patch->'trigger_config' ELSE trigger_config END,
    fallback_policy = CASE WHEN p_flow_patch ? 'fallback_policy' THEN p_flow_patch->'fallback_policy' ELSE fallback_policy END,
    entry_node_id = p_entry_node_id,
    updated_at = NOW()
  WHERE id = p_flow_id;
END;
$$;

ALTER FUNCTION public.save_flow_graph(UUID, UUID, TEXT, JSONB, BOOLEAN, JSONB) OWNER TO postgres;
-- Server-only — same shape as claim_ai_reply_slot / record_webhook_failure
-- / recompute_broadcast_counts (067_security_definer_hardening.sql):
-- REVOKE from authenticated too (not just PUBLIC/anon). The ONLY way
-- to reach this function is the Next.js backend's service-role client
-- (src/lib/flows/admin-client.ts), which never runs in the browser —
-- so the full functional graph validator in route.ts can never be
-- skipped by calling this RPC directly, closing achado #4.
REVOKE ALL ON FUNCTION public.save_flow_graph(UUID, UUID, TEXT, JSONB, BOOLEAN, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_flow_graph(UUID, UUID, TEXT, JSONB, BOOLEAN, JSONB) TO service_role;

-- ============================================================
-- VALIDAÇÃO MANUAL — rodar contra staging, nunca produção, antes de
-- aplicar em produção. Script completo e separado em
-- supabase/validation/070_flow_graph_save_rpc_check.sql (não faz
-- parte desta migration, não é aplicado por ela).
-- ============================================================
