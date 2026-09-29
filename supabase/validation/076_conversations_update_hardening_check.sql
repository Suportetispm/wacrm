-- ============================================================
-- 076_conversations_update_hardening_check.sql
--
-- Verificação SOMENTE LEITURA da migration 076 — segura em qualquer
-- ambiente, inclusive produção. Seção 1 é estrutural (introspecção
-- pura). Seção 2 é comportamental (dados sintéticos, BEGIN/ROLLBACK)
-- — mesma política de todo script deste projeto: só rodar em staging,
-- NUNCA em produção.
-- ============================================================

-- ============================================================
-- SEÇÃO 1 — estrutural (segura em produção)
-- ============================================================

-- Todas as policies de conversations, de uma vez
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'conversations'
ORDER BY policyname;
-- Esperado: exatamente 3 linhas.
--   conversations_insert — INALTERADA, with_check menciona só
--     is_account_member(account_id,'agent').
--   conversations_select — INALTERADA, qual = condição de 059
--     (admin vê tudo; agent/viewer restritos a assigned_agent_id/
--     queue_members).
--   conversations_update — NOVA: qual (USING) restrito a fila/
--     atribuição (mesma forma de select, sem o ramo de viewer);
--     with_check (WITH CHECK) SEPARADO — is_account_member(account_id,
--     'agent') + (assigned_agent_id IS NULL OR EXISTS profile da
--     MESMA conta) — deliberado, ver cabeçalho da migration 076
--     (revisão USING x WITH CHECK): nunca reexige assigned_agent_id/
--     queue_members da linha ATUAL na linha NOVA (senão reatribuir/
--     desatribuir por um agent fora da fila quebraria com erro de
--     RLS), mas exige que um assigned_agent_id não-nulo aponte para
--     um profile da mesma conta (bloqueia atribuir a usuário de outra
--     conta). NÃO exige profiles.is_active — dropdown real já permite
--     usuário inativo (confirmado em message-thread.tsx).
--   Nenhuma conversations_delete (075 já removeu).

-- Trigger novo existe e está habilitado
SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgrelid = 'public.conversations'::regclass AND NOT tgisinternal
ORDER BY tgname;
-- Esperado: enforce_privilege_columns (novo, BEFORE UPDATE) +
-- validate_queue_tenancy (058, já existia) + quaisquer outros
-- triggers pré-existentes (ex.: on_conversation_assigned, 027) —
-- nenhum deles removido.

-- Corpo da função do trigger — confirma TODAS as colunas protegidas
-- de uma vez, e confirma que assigned_agent_id NÃO está entre elas
-- (checagem textual simples, só para conferência rápida — a fonte de
-- verdade é o pg_get_functiondef completo, também retornado abaixo)
SELECT
  prosrc ILIKE '%account_id%'     AS protects_account_id,
  prosrc ILIKE '%queue_id%'       AS protects_queue_id,
  prosrc ILIKE '%contact_id%'     AS protects_contact_id,
  prosrc ILIKE '%NEW.user_id%'    AS protects_user_id,
  prosrc ILIKE '%created_at%'     AS protects_created_at,
  prosrc ILIKE '%unread_count%'   AS protects_unread_count,
  prosrc ILIKE '%assigned_agent_id%' AS mentions_assigned_agent_id
FROM pg_proc
WHERE oid = 'public.conversations_enforce_privilege_columns()'::regprocedure;
-- Esperado: todas as 6 primeiras colunas true.
-- mentions_assigned_agent_id deve ser FALSE — confirmação de que a
-- regra final NÃO restringe assigned_agent_id (decisão deliberada,
-- ver cabeçalho da migration 076: reatribuição livre entre colegas é
-- comportamento legítimo e vigente do Inbox, confirmado no dropdown
-- de message-thread.tsx).

-- Definição completa da função, para revisão manual linha a linha
SELECT pg_get_functiondef('public.conversations_enforce_privilege_columns()'::regprocedure);

-- owner da função — deve continuar postgres (CREATE OR REPLACE nunca
-- muda owner sozinho; 076 não emite nenhum ALTER FUNCTION OWNER)
SELECT r.rolname AS owner
FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
WHERE p.oid = 'public.conversations_enforce_privilege_columns()'::regprocedure;
-- Esperado: postgres.

-- ACL da função do trigger — PUBLIC/anon/authenticated/service_role
-- sem EXECUTE (via aclexplode, evita o erro de
-- has_function_privilege('PUBLIC', ...) — mesma técnica de 072/073/074)
SELECT
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END AS grantee,
  acl.privilege_type
FROM pg_proc p
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
WHERE p.oid = 'public.conversations_enforce_privilege_columns()'::regprocedure
ORDER BY grantee, acl.privilege_type;
-- Esperado: ZERO linhas com privilege_type='EXECUTE' para PUBLIC,
-- anon, authenticated OU service_role — nenhuma role de cliente tem
-- EXECUTE nesta função (076 revoga das 4 explicitamente). Não é
-- necessário para o trigger funcionar (ver comentário no cabeçalho
-- da migration) — o mecanismo de disparo do Postgres não passa por
-- ACL/GRANT.

-- Resumo booleano rápido do mesmo conjunto de roles
SELECT
  has_function_privilege('anon', 'public.conversations_enforce_privilege_columns()', 'EXECUTE')          AS anon_can_execute,
  has_function_privilege('authenticated', 'public.conversations_enforce_privilege_columns()', 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('service_role', 'public.conversations_enforce_privilege_columns()', 'EXECUTE')  AS service_role_can_execute,
  has_function_privilege('postgres', 'public.conversations_enforce_privilege_columns()', 'EXECUTE')      AS postgres_can_execute;
-- Esperado: anon/authenticated/service_role tudo false.
-- postgres_can_execute: true por ser o owner (owner sempre pode
-- executar a própria função, independente de GRANT).

-- ============================================================
-- SEÇÃO 2 — comportamental (SÓ STAGING, BEGIN/ROLLBACK — NUNCA
-- PRODUÇÃO)
-- ============================================================

BEGIN;

DO $outer$
DECLARE
  v_account_a         UUID := gen_random_uuid();
  v_account_b         UUID := gen_random_uuid();
  v_owner_a           UUID := gen_random_uuid();
  v_agent_in_queue    UUID := gen_random_uuid(); -- membro ativo da fila da conversa
  v_agent_out_queue   UUID := gen_random_uuid(); -- NÃO membro, não atribuído
  v_agent_assigned    UUID := gen_random_uuid(); -- não é membro da fila, mas é o assigned_agent_id
  v_agent_teammate    UUID := gen_random_uuid(); -- colega qualquer, alvo de reatribuição
  v_agent_account_b   UUID := gen_random_uuid(); -- usuário de OUTRA conta (account_b)

  v_queue_id          UUID := gen_random_uuid();
  v_other_queue_id    UUID := gen_random_uuid();
  v_contact_id        UUID := gen_random_uuid();
  v_other_contact_id  UUID := gen_random_uuid();

  v_conv_in_scope     UUID := gen_random_uuid(); -- fila = v_queue_id, sem assigned
  v_conv_assigned     UUID := gen_random_uuid(); -- fila = v_other_queue_id, assigned = v_agent_assigned

  v_rows_affected     INT;
  v_result            RECORD;
BEGIN
  RAISE NOTICE '=== 076 validation: building synthetic fixtures ===';

  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_owner_a,         '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__076_check__owner_a@example.com',         'x', now(), now(), now(), '{}', '{}'),
    (v_agent_in_queue,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__076_check__agent_in_queue@example.com',  'x', now(), now(), now(), '{}', '{}'),
    (v_agent_out_queue, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__076_check__agent_out_queue@example.com', 'x', now(), now(), now(), '{}', '{}'),
    (v_agent_assigned,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__076_check__agent_assigned@example.com',  'x', now(), now(), now(), '{}', '{}'),
    (v_agent_teammate,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__076_check__agent_teammate@example.com',  'x', now(), now(), now(), '{}', '{}'),
    (v_agent_account_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__076_check__agent_account_b@example.com', 'x', now(), now(), now(), '{}', '{}');

  INSERT INTO public.accounts (id, name, owner_user_id, is_active)
  VALUES
    (v_account_a, '__076_check__ Account A', v_owner_a, true),
    (v_account_b, '__076_check__ Account B', v_agent_account_b, true);

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES
    (v_owner_a,         '__076_check__ Owner',         '__076_check__owner_a@example.com',         v_account_a, 'owner', true),
    (v_agent_in_queue,  '__076_check__ Agent InQueue',  '__076_check__agent_in_queue@example.com',  v_account_a, 'agent', true),
    (v_agent_out_queue, '__076_check__ Agent OutQueue', '__076_check__agent_out_queue@example.com', v_account_a, 'agent', true),
    (v_agent_assigned,  '__076_check__ Agent Assigned', '__076_check__agent_assigned@example.com',  v_account_a, 'agent', true),
    (v_agent_teammate,  '__076_check__ Agent Teammate', '__076_check__agent_teammate@example.com',  v_account_a, 'agent', true),
    (v_agent_account_b, '__076_check__ Agent AccountB', '__076_check__agent_account_b@example.com', v_account_b, 'owner', true);

  INSERT INTO public.queues (id, account_id, name, is_active)
  VALUES
    (v_queue_id,       v_account_a, '__076_check__ Queue In',    true),
    (v_other_queue_id, v_account_a, '__076_check__ Queue Other', true);

  INSERT INTO public.queue_members (account_id, queue_id, user_id, is_active)
  VALUES (v_account_a, v_queue_id, v_agent_in_queue, true);
  -- v_agent_out_queue, v_agent_assigned e v_agent_teammate NÃO são
  -- membros de nenhuma fila.

  INSERT INTO public.contacts (id, user_id, account_id, phone, name)
  VALUES
    (v_contact_id,       v_owner_a, v_account_a, '+5511900000099', '__076_check__ Contact'),
    (v_other_contact_id, v_owner_a, v_account_a, '+5511900000098', '__076_check__ Contact Other');

  INSERT INTO public.conversations (id, user_id, account_id, contact_id, status, queue_id, assigned_agent_id)
  VALUES (v_conv_in_scope, v_owner_a, v_account_a, v_contact_id, 'pending', v_queue_id, NULL);

  INSERT INTO public.conversations (id, user_id, account_id, contact_id, status, queue_id, assigned_agent_id)
  VALUES (v_conv_assigned, v_owner_a, v_account_a, v_contact_id, 'in_progress', v_other_queue_id, v_agent_assigned);

  RAISE NOTICE 'Fixtures ready.';

  -- ============================================================
  -- 1) agent fora da fila e não atribuído não consegue UPDATE
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_out_queue)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET status = 'closed' WHERE id = v_conv_in_scope;
  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  RESET ROLE;
  IF v_rows_affected <> 0 THEN
    RAISE EXCEPTION 'FAIL 1: agent fora da fila e não atribuído NÃO deveria conseguir atualizar';
  END IF;
  RAISE NOTICE 'PASS 1: agent fora do escopo não consegue UPDATE (0 linhas afetadas)';

  -- ============================================================
  -- 2) agent da fila consegue alterar status
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_in_queue)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET status = 'in_progress' WHERE id = v_conv_in_scope;
  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  RESET ROLE;
  IF v_rows_affected <> 1 THEN
    RAISE EXCEPTION 'FAIL 2: agent membro ativo da fila deveria conseguir atualizar status';
  END IF;
  RAISE NOTICE 'PASS 2: agent da fila consegue alterar status';

  -- ============================================================
  -- 3) agent atribuído consegue alterar status (mesmo fora da fila)
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_assigned)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET status = 'waiting_customer' WHERE id = v_conv_assigned;
  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  RESET ROLE;
  IF v_rows_affected <> 1 THEN
    RAISE EXCEPTION 'FAIL 3: agent atribuído deveria conseguir atualizar status mesmo fora da fila';
  END IF;
  RAISE NOTICE 'PASS 3: agent atribuído consegue alterar status';

  -- ============================================================
  -- 4) agent NÃO consegue alterar account_id (dentro do escopo)
  -- ============================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_in_queue)::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE public.conversations SET account_id = v_account_b WHERE id = v_conv_in_scope;
    RAISE EXCEPTION 'FAIL 4: agent conseguiu mudar account_id — trigger não bloqueou';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 4: trigger bloqueia account_id';
  END;

  -- ============================================================
  -- 5) agent NÃO consegue alterar queue_id
  -- ============================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_assigned)::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE public.conversations SET queue_id = v_queue_id WHERE id = v_conv_assigned;
    RAISE EXCEPTION 'FAIL 5: agent conseguiu mudar queue_id diretamente';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 5: trigger bloqueia queue_id mesmo dentro do escopo permitido';
  END;

  -- ============================================================
  -- 6) agent NÃO consegue alterar contact_id
  -- ============================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_in_queue)::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE public.conversations SET contact_id = v_other_contact_id WHERE id = v_conv_in_scope;
    RAISE EXCEPTION 'FAIL 6: agent conseguiu mudar contact_id diretamente';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 6: trigger bloqueia contact_id';
  END;

  -- ============================================================
  -- 7) agent NÃO consegue alterar user_id
  -- ============================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_in_queue)::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE public.conversations SET user_id = v_agent_in_queue WHERE id = v_conv_in_scope;
    RAISE EXCEPTION 'FAIL 7: agent conseguiu mudar user_id diretamente';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 7: trigger bloqueia user_id';
  END;

  -- ============================================================
  -- 8) agent NÃO consegue alterar created_at
  -- ============================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_in_queue)::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE public.conversations SET created_at = now() - interval '1 day' WHERE id = v_conv_in_scope;
    RAISE EXCEPTION 'FAIL 8: agent conseguiu mudar created_at diretamente';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 8: trigger bloqueia created_at';
  END;

  -- ============================================================
  -- 9) agent NÃO consegue alterar unread_count
  -- ============================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_in_queue)::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE public.conversations SET unread_count = 999 WHERE id = v_conv_in_scope;
    RAISE EXCEPTION 'FAIL 9: agent conseguiu mudar unread_count diretamente';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 9: trigger bloqueia unread_count';
  END;

  -- ============================================================
  -- 10) assigned_agent_id segue a regra legítima confirmada:
  --     reatribuição livre entre colegas, dentro do escopo da linha
  --     (não restrita a self, não restrita a membro da fila) —
  --     confirma tanto "atribuir a um colega qualquer" quanto
  --     "desatribuir" (null), a partir de um agent DENTRO do escopo
  --     por ser membro da fila (caso mais simples).
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_in_queue)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET assigned_agent_id = v_agent_teammate WHERE id = v_conv_in_scope;
  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  RESET ROLE;
  IF v_rows_affected <> 1 THEN
    RAISE EXCEPTION 'FAIL 10a: agent dentro do escopo deveria poder reatribuir a QUALQUER colega (comportamento vigente do Inbox)';
  END IF;
  RAISE NOTICE 'PASS 10a: reatribuição livre a um colega (fora da fila) funciona normalmente';

  -- v_conv_in_scope agora está assigned a v_agent_teammate — v_agent_in_queue
  -- ainda consegue tocar a linha por ser membro ativo da fila.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_in_queue)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET assigned_agent_id = NULL WHERE id = v_conv_in_scope;
  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  RESET ROLE;
  IF v_rows_affected <> 1 THEN
    RAISE EXCEPTION 'FAIL 10b: desatribuir (assigned_agent_id=NULL) deveria continuar funcionando';
  END IF;
  RAISE NOTICE 'PASS 10b: desatribuição (NULL) funciona normalmente';

  -- ============================================================
  -- 10c/10d) O CENÁRIO QUE MOTIVOU A CORREÇÃO USING x WITH CHECK:
  --     agent que NÃO é membro de NENHUMA fila, mas É o
  --     assigned_agent_id ATUAL de v_conv_assigned (só passa no
  --     USING pela cláusula assigned_agent_id=auth.uid(), nunca pela
  --     de queue_members). Reatribuir para outro colega faz a linha
  --     NOVA ter assigned_agent_id<>auth.uid() E o agent continua
  --     fora de toda fila — com USING reaproveitado como WITH CHECK
  --     (versão antiga, incorreta, da policy) isso geraria ERRO de
  --     RLS em vez de simplesmente funcionar. Com WITH CHECK separado
  --     (só tenancy/role), deve funcionar normalmente.
  -- ============================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_assigned)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET assigned_agent_id = v_agent_teammate WHERE id = v_conv_assigned;
  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  RESET ROLE;
  IF v_rows_affected <> 1 THEN
    RAISE EXCEPTION 'FAIL 10c: agent atribuído mas fora de QUALQUER fila deveria conseguir reatribuir para outro colega (cenário que motivou a correção USING x WITH CHECK)';
  END IF;
  RAISE NOTICE 'PASS 10c: agent atribuído (fora de toda fila) consegue reatribuir para outro colega — WITH CHECK não bloqueia mais este fluxo legítimo';

  -- Devolve a conversation para v_agent_assigned para testar a
  -- desatribuição a partir do mesmo estado (fora de toda fila, mas
  -- atribuído) — precisa ser feito como o próprio agent, já que
  -- agora ele não é mais o assigned_agent_id (v_agent_teammate é).
  -- Usa v_owner_a (admin) só para resetar o fixture antes do teste
  -- seguinte, sem contar como parte do que está sendo testado.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner_a)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET assigned_agent_id = v_agent_assigned WHERE id = v_conv_assigned;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_assigned)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET assigned_agent_id = NULL WHERE id = v_conv_assigned;
  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  RESET ROLE;
  IF v_rows_affected <> 1 THEN
    RAISE EXCEPTION 'FAIL 10d: agent atribuído mas fora de QUALQUER fila deveria conseguir se desatribuir (assigned_agent_id=NULL)';
  END IF;
  RAISE NOTICE 'PASS 10d: agent atribuído (fora de toda fila) consegue se desatribuir — desatribuição legítima confirmada';

  -- ============================================================
  -- 11) agent dentro do escopo tenta atribuir assigned_agent_id para
  --     um usuário de OUTRA conta (v_agent_account_b) -> deve falhar.
  --     Este é o achado desta rodada: sem a checagem de "mesma conta"
  --     no WITH CHECK, isso passaria silenciosamente antes.
  -- ============================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_in_queue)::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE public.conversations SET assigned_agent_id = v_agent_account_b WHERE id = v_conv_in_scope;
    RAISE EXCEPTION 'FAIL 11: agent conseguiu atribuir a conversation a um usuário de OUTRA conta — WITH CHECK não bloqueou';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 11: WITH CHECK bloqueia atribuição a usuário de outra conta (RLS violation, código 42501)';
  END;

  -- ============================================================
  -- 12) service_role/postgres permanecem fora destas restrições —
  --     tanto do trigger (current_user<>'authenticated') quanto,
  --     por extensão, de RLS (bypassa por definição/ownership).
  --
  --     IMPORTANTE — o que este teste PROVA e o que NÃO prova: o
  --     UPDATE abaixo roda sem nenhum `SET LOCAL ROLE`/`SET_CONFIG`
  --     anterior nesta iteração — ou seja, executa com o role da
  --     PRÓPRIA CONEXÃO do script (tipicamente `postgres`, já que é
  --     quem normalmente roda scripts de validação manuais em
  --     staging). Isto prova que `postgres`/owner não é afetado pelo
  --     trigger nem pela RLS (RLS não se aplica ao dono da tabela por
  --     padrão, sem FORCE ROW LEVEL SECURITY). Isto NÃO prova o
  --     comportamento de `service_role` especificamente — para provar
  --     isso de verdade seria necessário `SET LOCAL ROLE
  --     service_role` explícito (o script não faz isso porque
  --     `service_role` normalmente não tem permissão de LOGIN direta
  --     em muitos ambientes Supabase, e o teste já teria o mesmo
  --     resultado por natureza: service_role tem BYPASSRLS e o
  --     trigger só checa `current_user='authenticated'`, nunca
  --     `service_role`). A confirmação de `service_role` específica
  --     fica para a Seção 1 (estrutural), que já reporta
  --     `service_role_can_execute` sobre a função do trigger.
  -- ============================================================
  UPDATE public.conversations
  SET queue_id = v_other_queue_id, account_id = account_id, contact_id = contact_id
  WHERE id = v_conv_in_scope;
  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected <> 1 THEN
    RAISE EXCEPTION 'FAIL 12: postgres (role da conexão) deveria continuar podendo alterar queue_id sem o guard do trigger';
  END IF;
  RAISE NOTICE 'PASS 12: postgres (role da conexão) não é afetado pelo trigger nem pela RLS — ver Seção 1 para confirmação estrutural de service_role';

  RAISE NOTICE '=== 076 validation: TODOS OS TESTES 1-12 PASSARAM ===';
END;
$outer$;

ROLLBACK;
