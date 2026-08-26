-- ============================================================
-- 062_user_permission_overrides
--
-- FASE 1 de permissões administrativas por usuário — overrides
-- individuais, restritos a account_role = 'agent'. owner/admin/
-- viewer NÃO são afetados por esta migration: seu comportamento
-- continua vindo exclusivamente de account_role_enum, exatamente
-- como hoje. Superadmin (public.platform_admins,
-- 046_platform_admin_foundation.sql) permanece completamente
-- separado — esta tabela nunca concede acesso ao Superadmin, e
-- 'superadmin.access' NÃO existe no catálogo de permission_key
-- abaixo (nem em nenhuma lista de valores aceitos).
--
-- Ausência de linha para (account_id, user_id, permission_key) =
-- Herdar (usa o default do agent, ver AGENT_PERMISSION_DEFAULTS em
-- src/lib/auth/permissions.ts). allowed=true = Permitir.
-- allowed=false = Bloquear.
--
-- Catálogo desta fase (12 chaves). Remoção de membro da conta
-- (DELETE /api/account/members/[userId], remove_account_member)
-- FICA FORA desta fase por decisão explícita — continua admin+ puro,
-- sem override individual, e remove_account_member (018) não é
-- tocada por esta migration em nenhum ponto. 'users.disable' e
-- 'users.remove' foram descartadas nas revisões desta feature:
-- não existe hoje nenhuma ação tenant-scope de "desativar" um
-- membro, e "remover" foi conscientemente deixado fora do escopo
-- para não precisar alterar remove_account_member nem investigar as
-- tabelas que ela referencia — isso fica registrado como possível
-- FASE futura, não como parte deste projeto:
--
--   users.view, users.create, users.edit
--   queues.view, queues.manage
--   flows.view, flows.manage, flows.activate
--   automations.view, automations.manage
--   quick_replies.view, quick_replies.manage
--
-- FK composta: reaproveita idx_profiles_user_account (039), o
-- UNIQUE INDEX ON profiles(user_id, account_id) já criado ali
-- especificamente "as a tenancy FK target" — não é necessária (nem
-- criada aqui) nenhuma constraint nova em profiles. queue_members
-- (039) já usa o mesmo índice do mesmo jeito:
--   FOREIGN KEY (user_id, account_id) REFERENCES profiles(user_id, account_id)
--
-- Sem policies RLS para authenticated/anon — mesmo padrão de
-- public.platform_admins (046): toda leitura/escrita passa por
-- código server-side com o client service-role, nunca pelo
-- PostgREST direto do navegador.
--
-- Idempotente — safe to run multiple times. NÃO EXECUTADA nesta
-- revisão (revisão pendente antes de aplicar no Supabase).
-- ============================================================

-- ============================================================
-- TABELA
-- ============================================================
CREATE TABLE IF NOT EXISTS user_permission_overrides (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  account_id UUID NOT NULL,
  permission_key TEXT NOT NULL CHECK (permission_key = ANY (ARRAY[
    'users.view', 'users.create', 'users.edit',
    'queues.view', 'queues.manage',
    'flows.view', 'flows.manage', 'flows.activate',
    'automations.view', 'automations.manage',
    'quick_replies.view', 'quick_replies.manage'
  ])),
  allowed BOOLEAN NOT NULL,
  -- Quem (Superadmin) setou este override por último — audit mínimo,
  -- nunca usado para autorização. SET NULL em vez de CASCADE: a
  -- remoção da conta do Superadmin não deve apagar o histórico de
  -- overrides que ele configurou em contas de terceiros.
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Garante que (user_id, account_id) sempre corresponde a uma linha
  -- real de profiles com aquele mesmo par — reaproveita
  -- idx_profiles_user_account (039), não cria constraint nova em
  -- profiles.
  FOREIGN KEY (user_id, account_id) REFERENCES profiles(user_id, account_id) ON DELETE CASCADE,
  UNIQUE (account_id, user_id, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_user_permission_overrides_lookup
  ON user_permission_overrides(account_id, user_id);

ALTER TABLE user_permission_overrides ENABLE ROW LEVEL SECURITY;
-- Nenhuma policy para authenticated/anon — leitura/escrita só via
-- service-role client (src/lib/permissions/admin-client.ts), gated em
-- código por requirePlatformAdmin() (escrita, rotas /api/admin/users/
-- [id]/permissions/**) ou pelo helper de permissão efetiva server-side
-- (leitura interna a partir de requirePermission()/getEffectivePermissions(),
-- nunca por uma query direta do navegador).

DROP TRIGGER IF EXISTS set_updated_at ON user_permission_overrides;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON user_permission_overrides
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- HELPER — usado exclusivamente pela autorização das duas RPCs
-- abaixo (create_account_member / set_member_role). Nunca chamado a
-- partir do client. remove_account_member (018) NÃO consulta este
-- helper — remoção de membro fica fora da FASE 1 (ver cabeçalho).
--
-- Ausência de linha para (account_id, user_id, permission_key) = false
-- (a mesma regra "ausência = Herdar" da tabela, mas aqui já resolvida
-- para o pior caso: sem override explícito allowed=true, uma ação
-- administrativa nunca é liberada para um agent).
-- ============================================================
CREATE OR REPLACE FUNCTION public.agent_has_permission_override(
  p_account_id UUID,
  p_user_id UUID,
  p_permission_key TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT allowed
      FROM user_permission_overrides
      WHERE account_id = p_account_id
        AND user_id = p_user_id
        AND permission_key = p_permission_key
    ),
    false
  );
$$;

ALTER FUNCTION public.agent_has_permission_override(UUID, UUID, TEXT) OWNER TO postgres;

-- Este helper é chamado exclusivamente de dentro de
-- create_account_member / set_member_role — ambas SECURITY DEFINER,
-- dono postgres. Uma função SECURITY DEFINER executa suas chamadas
-- internas com o papel do definer (postgres), não do chamador
-- original da sessão; como postgres também é dono deste helper, ele
-- já tem EXECUTE implícito, sem precisar de nenhum GRANT explícito.
-- Conceder EXECUTE para `authenticated` exporia a função como um RPC
-- público do PostgREST (`/rest/v1/rpc/agent_has_permission_override`)
-- — qualquer usuário autenticado, de qualquer conta, poderia então
-- consultar se um (account_id, user_id, permission_key) arbitrário de
-- OUTRA conta tem override concedido — um vazamento cross-tenant,
-- mesmo que só leitura de um booleano. `service_role` também nunca
-- chama este helper diretamente (nenhum código TS faz `.rpc('agent_
-- has_permission_override', ...)` — a leitura de overrides no lado
-- TypeScript vai direto na tabela via src/lib/permissions/store.ts).
-- Revoga-se de todos os papéis não-superuser explicitamente, em vez
-- de simplesmente omitir o GRANT, para o intento ficar auto-
-- documentado e resistente a um GRANT futuro acidental.
REVOKE ALL ON FUNCTION public.agent_has_permission_override(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_has_permission_override(UUID, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.agent_has_permission_override(UUID, UUID, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.agent_has_permission_override(UUID, UUID, TEXT) FROM service_role;

-- ============================================================
-- create_account_member — PATCH DE AUTORIZAÇÃO (056)
--
-- Único trecho alterado em relação a 056_account_member_direct_
-- creation.sql: a cláusula "v_caller_role NOT IN ('owner','admin') →
-- 42501" agora também aceita um agent com
-- user_permission_overrides('users.create') = true. TODA a lógica
-- funcional (validação de nome/e-mail/senha, elegibilidade do alvo,
-- reatribuição de profile/account, remoção da conta pessoal
-- temporária, queue_ids) permanece byte-a-byte idêntica.
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_account_member(
  p_user_id UUID,
  p_account_role account_role_enum,
  p_full_name TEXT,
  p_queue_ids UUID[] DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_trimmed_name TEXT;
  v_temp_account_id UUID;
  v_current_role account_role_enum;
  v_other_member_count INTEGER;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Conta de destino: sempre a do chamador, nunca um parâmetro.
  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM public.profiles
  WHERE user_id = v_caller_id;

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  -- ALTERADO (062): admin+ continua liberado direto pelo papel; um
  -- agent só passa com um override explícito allowed=true para
  -- 'users.create'. Qualquer outro caso (agent sem override, viewer)
  -- cai no mesmo 42501 de sempre.
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    IF NOT (
      v_caller_role = 'agent'
      AND public.agent_has_permission_override(v_caller_account_id, v_caller_id, 'users.create')
    ) THEN
      RAISE EXCEPTION 'This action requires the admin role or higher'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.accounts WHERE id = v_caller_account_id AND is_active
  ) THEN
    RAISE EXCEPTION 'Your account is disabled' USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_account_role IS NULL OR p_account_role NOT IN ('admin', 'agent', 'viewer') THEN
    RAISE EXCEPTION 'account_role must be admin, agent or viewer' USING ERRCODE = '22023';
  END IF;

  v_trimmed_name := btrim(p_full_name);
  IF v_trimmed_name IS NULL OR length(v_trimmed_name) = 0 THEN
    RAISE EXCEPTION 'full_name is required' USING ERRCODE = '22023';
  END IF;
  IF length(v_trimmed_name) > 120 THEN
    RAISE EXCEPTION 'full_name must be 120 characters or fewer' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'Target user does not exist' USING ERRCODE = '22023';
  END IF;

  -- Trava a linha de profile do alvo pela duração da transação —
  -- mesma técnica de platform_attach_user_to_account, para que duas
  -- chamadas concorrentes visando o mesmo p_user_id não leiam o
  -- mesmo estado "elegível" e tentem anexá-lo duas vezes.
  SELECT account_id, account_role INTO v_temp_account_id, v_current_role
  FROM public.profiles WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_temp_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user has no profile to attach' USING ERRCODE = '22023';
  END IF;

  -- Defesa em profundidade: nunca "anexar" alguém à própria conta
  -- que já é a conta de destino (não deveria ser alcançável — a
  -- rota sempre cria um auth.users novo — mas a RPC nunca confia só
  -- na camada de API).
  IF v_temp_account_id = v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is already a member of this account' USING ERRCODE = '23505';
  END IF;

  IF v_current_role <> 'owner' THEN
    RAISE EXCEPTION 'Target user is not eligible to be attached (unexpected role)' USING ERRCODE = '23505';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.accounts
    WHERE id = v_temp_account_id AND owner_user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Target user account ownership is inconsistent; refusing to attach' USING ERRCODE = '23505';
  END IF;

  SELECT count(*) INTO v_other_member_count
  FROM public.profiles
  WHERE account_id = v_temp_account_id AND user_id <> p_user_id;

  IF v_other_member_count > 0 THEN
    RAISE EXCEPTION 'Target user personal account already has other members; refusing to attach' USING ERRCODE = '23505';
  END IF;

  IF public.account_has_any_data(v_temp_account_id) THEN
    RAISE EXCEPTION 'Target user personal account already has operational data; refusing to attach' USING ERRCODE = '23505';
  END IF;

  IF p_queue_ids IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(p_queue_ids) qid
    WHERE NOT EXISTS (SELECT 1 FROM public.queues q WHERE q.id = qid AND q.account_id = v_caller_account_id)
  ) THEN
    RAISE EXCEPTION 'One or more queues do not belong to your account' USING ERRCODE = '22023';
  END IF;

  -- Move o profile para a conta do chamador. Ignora
  -- enforce_profile_privilege_columns porque esta função roda como
  -- postgres (current_user = 'postgres'), não authenticated.
  UPDATE public.profiles
  SET account_id = v_caller_account_id,
      account_role = p_account_role,
      full_name = v_trimmed_name,
      is_active = true
  WHERE user_id = p_user_id;

  -- A conta pessoal temporária agora está vazia (seu único profile
  -- acabou de sair) e já foi confirmada sem dado operacional — seguro
  -- apagar, mesmo destino que redeem_invitation (019) e
  -- platform_attach_user_to_account (048) já dão a esse formato de
  -- conta. Nunca é a conta do chamador (checagem acima).
  DELETE FROM public.accounts WHERE id = v_temp_account_id;

  IF p_queue_ids IS NOT NULL THEN
    INSERT INTO public.queue_members (account_id, queue_id, user_id, role_in_queue)
    SELECT v_caller_account_id, qid, p_user_id, 'agent'
    FROM unnest(p_queue_ids) qid
    ON CONFLICT (queue_id, user_id) DO NOTHING;
  END IF;

  RETURN p_user_id;
END;
$$;

ALTER FUNCTION public.create_account_member(UUID, account_role_enum, TEXT, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_account_member(UUID, account_role_enum, TEXT, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_account_member(UUID, account_role_enum, TEXT, UUID[]) FROM anon;
REVOKE ALL ON FUNCTION public.create_account_member(UUID, account_role_enum, TEXT, UUID[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.create_account_member(UUID, account_role_enum, TEXT, UUID[]) TO authenticated;

-- ============================================================
-- set_member_role — PATCH DE AUTORIZAÇÃO (018)
--
-- Único trecho alterado: a cláusula de "caller must be admin+" agora
-- também aceita um agent com override 'users.edit' = true. Continua
-- impossível: alterar a própria role (self-target), promover/rebaixar
-- 'owner' (segue exigindo transfer_account_ownership), ou mirar
-- alguém de outra account. Nada mais nesta função muda.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_user_id UUID,
  p_new_role account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
BEGIN
  -- Caller must be authenticated.
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Resolve caller's account + role.
  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = v_caller_id;

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  -- ALTERADO (062): admin+ continua liberado direto pelo papel; um
  -- agent só passa com um override explícito allowed=true para
  -- 'users.edit'.
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    IF NOT (
      v_caller_role = 'agent'
      AND public.agent_has_permission_override(v_caller_account_id, v_caller_id, 'users.edit')
    ) THEN
      RAISE EXCEPTION 'This action requires the admin role or higher'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Can't change own role via this endpoint.
  IF p_user_id = v_caller_id THEN
    RAISE EXCEPTION 'Cannot change your own role'
      USING ERRCODE = '22023';
  END IF;

  -- Resolve target.
  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  -- Target must be in caller's account.
  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  -- Owner role changes go through transfer_account_ownership.
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner'
      USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner'
      USING ERRCODE = '22023';
  END IF;

  UPDATE profiles
  SET account_role = p_new_role
  WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.set_member_role(UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_role(UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, account_role_enum) TO authenticated;

-- ============================================================
-- remove_account_member — FORA DA FASE 1, DE PROPÓSITO.
--
-- Esta migration NÃO define, NÃO altera e NÃO referencia
-- remove_account_member em nenhum ponto. A função continua sendo
-- exclusivamente a definição de 018_account_member_rpcs.sql — sem
-- override individual, sem chamada a agent_has_permission_override,
-- sem qualquer DELETE em user_permission_overrides/queue_members/
-- internal_team_members. DELETE /api/account/members/[userId]
-- continua usando requireRole('admin') puro, exatamente como antes
-- desta feature.
--
-- Durante o desenvolvimento desta migration, uma versão anterior
-- chegou a patchear remove_account_member com um override
-- 'users.remove' e, na auditoria seguinte, precisou de limpezas
-- adicionais em queue_members e internal_team_members (FKs compostas
-- para profiles(user_id, account_id) que a troca de account_id
-- violaria). Essa investigação foi revertida por decisão de escopo —
-- fica registrada aqui só para quem reabrir o assunto no futuro não
-- repetir a mesma descoberta do zero, não porque haja qualquer
-- correção pendente nesta migration.
-- ============================================================

-- ============================================================
-- VALIDAÇÃO MANUAL (mesmo formato de 056_account_member_direct_
-- creation.sql) — a rodar manualmente depois de aplicar esta
-- migration em um ambiente de teste, antes de promover para produção.
-- Nada disto é executado automaticamente por esta migration.
-- ============================================================
--
-- A. agent sem override continua bloqueado (idêntico a hoje):
--
-- -- logado como agent, sem nenhuma linha em user_permission_overrides
-- SELECT create_account_member('<user-id>', 'agent', 'Teste', NULL);
-- SELECT set_member_role('<user-id>', 'viewer');
-- Esperado, nas duas: ERRO 42501 "This action requires the admin role or higher"
--
--
-- B. agent com override allowed=true na chave correspondente passa:
--
-- INSERT INTO user_permission_overrides (account_id, user_id, permission_key, allowed)
-- VALUES ('<account-id>', '<agent-user-id>', 'users.edit', true);
-- -- logado como esse agent:
-- SELECT set_member_role('<other-user-id>', 'viewer');
-- Esperado: sucesso, igual ao que um admin já conseguia.
--
--
-- C. override allowed=false nunca libera (equivalente a "sem override"):
--
-- INSERT INTO user_permission_overrides (account_id, user_id, permission_key, allowed)
-- VALUES ('<account-id>', '<agent-user-id>', 'users.edit', false);
-- SELECT set_member_role('<other-user-id>', 'viewer');
-- Esperado: ERRO 42501, mesma mensagem de A.
--
--
-- D. mesmo com override, proteções estruturais continuam de pé:
--
-- -- self-target:
-- SELECT set_member_role('<agent-user-id>', 'viewer'); -- o próprio chamador
-- Esperado: ERRO 22023 "Cannot change your own role"
--
-- -- alvo = owner:
-- SELECT set_member_role('<owner-user-id>', 'admin');
-- Esperado: ERRO 22023 "Use transfer_account_ownership to demote an owner"
--
-- -- alvo de outra account:
-- SELECT set_member_role('<user-id-de-outra-account>', 'viewer');
-- Esperado: ERRO 42501 "Target user is not a member of your account"
--
-- -- não promove a owner mesmo com override:
-- SELECT set_member_role('<user-id>', 'owner');
-- Esperado: ERRO 22023 "Use transfer_account_ownership to promote to owner"
--
--
-- E. owner/admin continuam funcionando exatamente como antes desta
--    migration (nenhuma das duas funções muda comportamento para eles
--    — a nova ramificação só é avaliada quando v_caller_role = 'agent'):
--
-- -- logado como admin ou owner, sem nenhuma linha de override:
-- SELECT create_account_member(...); SELECT set_member_role(...);
-- Esperado: mesmo resultado de antes da 062.
--
--
-- F. agent_has_permission_override nunca é chamável fora destas RPCs
--    de forma útil para escalar privilégio — ela só LÊ a tabela, não
--    escreve; escrever overrides continua exclusivo das rotas
--    /api/admin/users/[id]/permissions (requirePlatformAdmin()).
--
--
-- G. remove_account_member não é afetada por esta migration:
--
-- -- logado como admin ou owner:
-- SELECT remove_account_member('<agent-user-id>');
-- Esperado: exatamente o mesmo comportamento de antes da 062 (nenhuma
-- linha de user_permission_overrides é lida ou apagada por esta
-- função, nenhuma linha de queue_members/internal_team_members é
-- tocada por esta função).
--
-- -- logado como agent, mesmo com QUALQUER override configurado:
-- SELECT remove_account_member('<other-user-id>');
-- Esperado: ERRO 42501 "This action requires the admin role or higher"
-- — idêntico a antes da FASE 1, porque remove_account_member nunca
-- chama agent_has_permission_override.
