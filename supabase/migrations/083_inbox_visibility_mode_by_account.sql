-- ============================================================
-- 083_inbox_visibility_mode_by_account
--
-- Restaura a segmentação da Caixa de Entrada por Setor (059/076) como
-- comportamento PADRÃO, e mantém a Inbox account-wide (082) apenas
-- para as accounts que tiverem a feature flag `inbox_account_wide`
-- habilitada em public.account_feature_flags (071).
--
-- ------------------------------------------------------------
-- Dois modos de Inbox, decididos por account
-- ------------------------------------------------------------
--   inbox_account_wide = true            -> account-wide (regra da 082)
--   flag ausente OU enabled = false      -> segmentada por Setor
--                                           (regra da 059 no SELECT e
--                                           da 076 no UPDATE)
-- O default é segmentado de propósito: account nova nasce sem linha em
-- account_feature_flags e, portanto, por Setor. Mesma semântica
-- fail-closed de src/lib/accounts/feature-flags.ts.
--
-- A RLS depende SOMENTE de (account_id, flag) — nunca do nome da
-- empresa. As duas accounts que recebem a flag nesta migration são
-- identificadas por UUID (seção 4).
--
-- ------------------------------------------------------------
-- O que esta migration faz (tudo em UMA transação)
-- ------------------------------------------------------------
--   1. CHECK de account_feature_flags.feature_key passa a aceitar
--      'inbox_account_wide' (além das duas chaves da 071).
--   2. platform_set_account_feature(): allowlist ganha a chave nova.
--      Corpo de resto IDÊNTICO ao da 071 (SECURITY DEFINER,
--      search_path = public, is_platform_admin(), updated_by,
--      platform_audit_log). ACL reafirmada como 071/072.
--   3. Função nova is_account_feature_enabled(account_id, feature_key)
--      — o único caminho pelo qual a RLS (role authenticated) lê a
--      flag. Ver seção própria para o desenho de segurança.
--   4. inbox_account_wide = true para exatamente 2 accounts.
--   5. conversations_select híbrida.
--   6. conversations_update híbrida (WITH CHECK inalterado da 076/082).
--
-- ------------------------------------------------------------
-- NÃO FAZ
-- ------------------------------------------------------------
-- Não altera linhas de conversations/messages/contacts/tickets, não
-- faz backfill de queue_id/assigned_agent_id, não toca
-- conversations_insert, a ausência de conversations_delete (075),
-- messages_*, tickets_*, queues, queue_members, is_account_member, o
-- trigger enforce_privilege_columns (076/078), Flows, UAZAPI ou
-- whatsapp_config. service_role (webhooks, Flow engine) e as RPCs
-- SECURITY DEFINER de ticket continuam bypassando RLS — o Flow segue
-- gravando queue_id normalmente.
--
-- messages: messages_select/messages_modify (017) fazem
--   EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id
--           AND is_account_member(c.account_id[, 'agent']))
-- e essa subquery em conversations é avaliada com a RLS de
-- conversations do próprio chamador. Logo messages acompanha
-- automaticamente a visibilidade da conversation nos dois modos —
-- nenhuma alteração em messages é necessária (mesma situação que já
-- valia entre a 059 e a 082).
--
-- Realtime: postgres_changes avalia conversations_select por
-- assinante. Account-wide continua recebendo todo evento da account;
-- por Setor só recebe o que a policy permite (a conversa nova, sem
-- fila, só chega ao agent quando o Flow grava queue_id — como UPDATE).
--
-- Idempotente — seguro reexecutar (reexecutar RELIGA a flag das duas
-- accounts da seção 4 caso alguém a tenha desligado nesse meio tempo).
-- Preflight: supabase/validation/083_inbox_visibility_mode_by_account_preflight.sql
-- Check:     supabase/validation/083_inbox_visibility_mode_by_account_check.sql
-- ============================================================

-- ------------------------------------------------------------
-- Atomicidade — mesma convenção da 081/082
-- ------------------------------------------------------------
-- Transação EXPLÍCITA: constraint, RPC, função auxiliar, flags e as
-- duas policies entram juntas ou nada muda. Em nenhum instante
-- visível a outra sessão conversations fica sem policy de SELECT/
-- UPDATE, nem existe o estado intermediário "policy por Setor já
-- ativa, flag das duas accounts ainda não gravada". DDL de policy pega
-- ACCESS EXCLUSIVE em conversations (e o ALTER TABLE em
-- account_feature_flags) até o COMMIT; lock_timeout curto faz a
-- migration falhar rápido em vez de enfileirar o tráfego do app.
-- ============================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ============================================================
-- 1) CHECK de feature_key — aceita a chave nova
--
--    A 071 criou o CHECK inline (nome gerado pelo Postgres, por
--    convenção account_feature_flags_feature_key_check). Em vez de
--    presumir o nome, remove todo CHECK da tabela que referencie
--    feature_key e recria com nome explícito.
-- ============================================================
DO $$
DECLARE
  v_conname TEXT;
BEGIN
  FOR v_conname IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'public.account_feature_flags'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%feature_key%'
  LOOP
    EXECUTE format('ALTER TABLE public.account_feature_flags DROP CONSTRAINT %I', v_conname);
  END LOOP;
END;
$$;

ALTER TABLE public.account_feature_flags
  ADD CONSTRAINT account_feature_flags_feature_key_check
  CHECK (feature_key = ANY (ARRAY[
    'multi_connection_enabled',
    'business_units_enabled',
    'inbox_account_wide'
  ]));

-- ============================================================
-- 2) platform_set_account_feature — allowlist + mensagem de erro
--
--    Única diferença para o corpo da 071: 'inbox_account_wide' na
--    allowlist e na mensagem. CREATE OR REPLACE preserva owner e ACL;
--    owner/REVOKE/GRANT são reafirmados abaixo (no-op quando já
--    aplicados), no mesmo formato de 071/072.
-- ============================================================
CREATE OR REPLACE FUNCTION public.platform_set_account_feature(
  p_account_id UUID,
  p_feature_key TEXT,
  p_enabled BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_previous_enabled BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'account_id is required' USING ERRCODE = '22023';
  END IF;

  IF p_feature_key IS NULL THEN
    RAISE EXCEPTION 'feature_key is required' USING ERRCODE = '22023';
  END IF;

  IF p_feature_key <> ALL (ARRAY['multi_connection_enabled', 'business_units_enabled', 'inbox_account_wide']) THEN
    RAISE EXCEPTION 'feature_key must be one of: multi_connection_enabled, business_units_enabled, inbox_account_wide'
      USING ERRCODE = '22023';
  END IF;

  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'enabled is required' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = p_account_id) THEN
    RAISE EXCEPTION 'Account not found' USING ERRCODE = '22023';
  END IF;

  -- Garante que a linha existe (placeholder enabled=false na primeira
  -- vez; no-op se já existir) ANTES do FOR UPDATE — ver 071.
  INSERT INTO public.account_feature_flags (account_id, feature_key, enabled, updated_by)
  VALUES (p_account_id, p_feature_key, false, v_caller_id)
  ON CONFLICT (account_id, feature_key) DO NOTHING;

  SELECT enabled INTO v_previous_enabled
  FROM public.account_feature_flags
  WHERE account_id = p_account_id AND feature_key = p_feature_key
  FOR UPDATE;

  UPDATE public.account_feature_flags
  SET enabled = p_enabled, updated_by = v_caller_id
  WHERE account_id = p_account_id AND feature_key = p_feature_key;

  INSERT INTO public.platform_audit_log (actor_user_id, action, target_account_id, metadata)
  VALUES (
    v_caller_id,
    'platform_account_feature.set',
    p_account_id,
    jsonb_build_object(
      'feature_key', p_feature_key,
      'previous_enabled', v_previous_enabled,
      'new_enabled', p_enabled
    )
  );
END;
$$;

ALTER FUNCTION public.platform_set_account_feature(UUID, TEXT, BOOLEAN) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.platform_set_account_feature(UUID, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.platform_set_account_feature(UUID, TEXT, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.platform_set_account_feature(UUID, TEXT, BOOLEAN) TO authenticated;

-- ============================================================
-- 3) is_account_feature_enabled(p_account_id, p_feature_key)
--
--    account_feature_flags tem RLS habilitada e NENHUMA policy para
--    authenticated (071) — um EXISTS direto na policy de conversations
--    devolveria sempre false para o usuário. Esta função é a única
--    ponte, e é deliberadamente estreita:
--
--    - SECURITY DEFINER (owner postgres) só para atravessar a RLS de
--      account_feature_flags; SET search_path = '' com toda relação
--      schema-qualified (convenção 066/067/069).
--    - LANGUAGE sql STABLE, somente leitura: um único SELECT EXISTS.
--      Sem SQL dinâmico, sem escrita, sem retorno de linha/coluna —
--      só um BOOLEAN.
--    - Exige is_account_member(p_account_id) do PRÓPRIO chamador
--      (auth.uid() — vem do JWT, não muda dentro de SECURITY DEFINER).
--      Quem não é membro ativo da account recebe false, igual a "flag
--      ausente": não dá para sondar as flags de outra account nem
--      confirmar que um account_id existe. Não é um bypass genérico da
--      RLS da tabela.
--    - Nunca devolve NULL: flag ausente, enabled = false, account
--      inexistente, parâmetro NULL, chave desconhecida, chamador sem
--      JWT (inclusive service_role/postgres direto) => false.
--    - EXECUTE só para authenticated (é o role sob o qual as policies
--      de conversations são avaliadas, inclusive pelo Realtime).
--      service_role não precisa: bypassa RLS e o helper server-side lê
--      a tabela direto.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_account_feature_enabled(
  p_account_id UUID,
  p_feature_key TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.is_account_member(p_account_id)
    AND EXISTS (
      SELECT 1
      FROM public.account_feature_flags f
      WHERE f.account_id = p_account_id
        AND f.feature_key = p_feature_key
        AND f.enabled IS TRUE
    );
$$;

ALTER FUNCTION public.is_account_feature_enabled(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_account_feature_enabled(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_account_feature_enabled(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.is_account_feature_enabled(UUID, TEXT) FROM service_role;
GRANT EXECUTE ON FUNCTION public.is_account_feature_enabled(UUID, TEXT) TO authenticated;

-- ============================================================
-- 4) inbox_account_wide = true — SOMENTE estas duas accounts
--
--      3b1cc850-7de0-48df-ba1b-d6334b000c3b
--      33e1388c-fb0a-457f-ba8e-c01d236897c5
--
--    INSERT ... SELECT a partir de accounts: num ambiente em que essas
--    accounts não existem (staging/dev) nada é gravado e a migration
--    não quebra por FK — só emite WARNING. ON CONFLICT religa a flag
--    se ela existir desligada. updated_by fica NULL (não há ator
--    Superadmin numa migration); a mudança efetiva é registrada em
--    platform_audit_log com actor NULL e source = 'migration_083'.
--    Nenhuma outra account é tocada.
-- ============================================================
DO $$
DECLARE
  v_targets UUID[] := ARRAY[
    '3b1cc850-7de0-48df-ba1b-d6334b000c3b',
    '33e1388c-fb0a-457f-ba8e-c01d236897c5'
  ]::UUID[];
  v_enabled_targets INTEGER;
BEGIN
  WITH changed AS (
    INSERT INTO public.account_feature_flags AS f (account_id, feature_key, enabled)
    SELECT a.id, 'inbox_account_wide', true
    FROM public.accounts a
    WHERE a.id = ANY (v_targets)
    ON CONFLICT (account_id, feature_key) DO UPDATE
      SET enabled = true
      WHERE f.enabled IS DISTINCT FROM true
    RETURNING f.account_id
  )
  INSERT INTO public.platform_audit_log (actor_user_id, action, target_account_id, metadata)
  SELECT
    NULL,
    'platform_account_feature.set',
    changed.account_id,
    jsonb_build_object(
      'feature_key', 'inbox_account_wide',
      'new_enabled', true,
      'source', 'migration_083'
    )
  FROM changed;

  SELECT count(*) INTO v_enabled_targets
  FROM public.account_feature_flags f
  WHERE f.feature_key = 'inbox_account_wide'
    AND f.enabled
    AND f.account_id = ANY (v_targets);

  IF v_enabled_targets <> 2 THEN
    RAISE WARNING
      '083: inbox_account_wide habilitada para % de 2 accounts esperadas — as demais não existem neste banco e ficam segmentadas por Setor',
      v_enabled_targets;
  END IF;
END;
$$;

-- ============================================================
-- 5) conversations_select — híbrida
--
--    is_account_member(account_id) é exigido em TODOS os ramos (é o
--    que garante mesma account + profile ativo + account ativa, 048).
--    Dentro da account, basta UMA das condições:
--      - a account é account-wide (flag);
--      - o chamador é admin/owner;
--      - é o responsável (assigned_agent_id = auth.uid());
--      - é membro ATIVO da queue da conversation, na mesma account.
--
--    Com a flag desligada isto é exatamente a 059:
--      admin OR (agent abaixo de admin AND (responsável OR fila))
--            OR (viewer            AND (responsável OR fila))
--    — os ramos agent e viewer da 059 têm a mesma condição, então
--    "membro AND (admin OR responsável OR fila)" é a mesma expressão
--    fatorada. Com a flag ligada colapsa em is_account_member(
--    account_id), a regra da 082.
--
--    queue_id IS NULL nunca dá acesso: qm.queue_id = NULL não casa.
-- ============================================================
DROP POLICY IF EXISTS conversations_select ON public.conversations;
CREATE POLICY conversations_select ON public.conversations FOR SELECT
  USING (
    public.is_account_member(account_id)
    AND (
      public.is_account_feature_enabled(account_id, 'inbox_account_wide')
      OR public.is_account_member(account_id, 'admin')
      OR assigned_agent_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.queue_members qm
        WHERE qm.queue_id = conversations.queue_id
          AND qm.user_id = auth.uid()
          AND qm.account_id = conversations.account_id
          AND qm.is_active
      )
    )
  );

-- ============================================================
-- 6) conversations_update — híbrida
--
--    USING: agent+ da própria account (viewer nunca escreve) E
--      - account account-wide (regra da 082), OU
--      - admin/owner, OU responsável, OU membro ativo da queue
--        (regra da 076).
--    WITH CHECK: IDÊNTICO ao da 076/082 — agent+ da account e
--      assigned_agent_id, quando não NULL, apontando para um profile
--      da MESMA account. O trigger enforce_privilege_columns (076/078)
--      não é tocado: queue_id, account_id etc. seguem bloqueados para
--      authenticated nos dois modos.
-- ============================================================
DROP POLICY IF EXISTS conversations_update ON public.conversations;
CREATE POLICY conversations_update ON public.conversations FOR UPDATE
  USING (
    public.is_account_member(account_id, 'agent')
    AND (
      public.is_account_feature_enabled(account_id, 'inbox_account_wide')
      OR public.is_account_member(account_id, 'admin')
      OR assigned_agent_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.queue_members qm
        WHERE qm.queue_id = conversations.queue_id
          AND qm.user_id = auth.uid()
          AND qm.account_id = conversations.account_id
          AND qm.is_active
      )
    )
  )
  WITH CHECK (
    public.is_account_member(account_id, 'agent')
    AND (
      assigned_agent_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = conversations.assigned_agent_id
          AND p.account_id = conversations.account_id
      )
    )
  );

COMMIT;
