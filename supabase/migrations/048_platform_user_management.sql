-- ============================================================
-- 048_platform_user_management
--
-- FASE 6C.3B — permite que o Superadmin (public.platform_admins, ver
-- 046_platform_admin_foundation.sql) crie e gerencie usuários de
-- tenant (profiles.account_role IN admin|agent) diretamente, sem
-- depender do convite (account_invitations, 017/019) como fluxo
-- principal. O convite legado continua existindo e funcional.
--
-- AUDITORIA PRÉVIA (resumo — ver resposta da fase 6C.3A para o
-- detalhe completo):
--   - a ÚNICA forma de uma linha nascer em auth.users hoje já
--     dispara handle_new_user() (017_account_sharing.sql), que
--     SEMPRE cria uma accounts pessoal + profiles(account_role=owner)
--     — inclusive quando o insert vem de
--     supabase.auth.admin.createUser() no servidor, não só do signup
--     público. Não há branch de convite ali;
--   - profiles não tem hoje nenhuma coluna de ativo/inativo;
--   - platform_create_account (047) já resolve um problema irmão
--     deste — reaproveitar uma conta pessoal vazia em vez de
--     apagar/recriar — mas foi desenhada para o OWNER de uma empresa
--     nova, não para vincular um usuário interno (admin/agent) a uma
--     empresa já existente. Não é reutilizada aqui como está; o
--     mesmo padrão de elegibilidade (dono único, zero membros, zero
--     dado operacional via account_has_any_data()) é replicado por
--     platform_attach_user_to_account abaixo, aplicado à conta de
--     ORIGEM (a pessoal recém-criada) em vez da conta de destino.
--
-- NESTA FASE:
--   - profiles ganha is_active (status operacional do usuário,
--     independente de accounts.is_active, que é o status da empresa);
--   - is_account_member() passa a exigir também profiles.is_active —
--     mesma decisão de arquitetura já tomada para accounts.is_active
--     em 047: dezenas de componentes client consultam o Supabase
--     direto do navegador, então o bloqueio real só pode viver na
--     RLS, não só na camada de API;
--   - enforce_profile_privilege_columns (034) passa a proteger
--     também is_active — só as RPCs abaixo (rodando como postgres)
--     podem mudá-la, nunca um UPDATE direto do client;
--   - platform_attach_user_to_account / platform_update_user: RPCs
--     SECURITY DEFINER, mesmo padrão de auto-checagem de 046/047;
--   - NÃO cria tela /admin/users (fase 6C.3C), NÃO altera
--     account_role_enum, NÃO cria papel Supervisor, NÃO toca em
--     WhatsApp, Inbox, tickets ou queues além de queue_members (para
--     vincular o usuário às filas selecionadas).
-- ------------------------------------------------------------

-- ============================================================
-- PROFILES — status operacional do usuário
--
-- Distinto de accounts.is_active (047): uma empresa pode estar ativa
-- com um usuário individual desativado dentro dela. Mesmo padrão:
-- nunca exclusão física.
-- ============================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_profiles_account_active ON public.profiles(account_id, is_active);

-- ============================================================
-- IS_ACCOUNT_MEMBER() — agora também exige profiles.is_active
--
-- Mesma decisão de arquitetura documentada em 047_platform_account_
-- management.sql para accounts.is_active, aplicada agora ao lado do
-- usuário: a checagem precisa valer para toda policy de RLS que já
-- chama is_account_member() (contacts, conversations, queues,
-- tickets, whatsapp_config, etc.), não só para as rotas /api/**, já
-- que boa parte do produto consulta o Supabase diretamente do
-- navegador. Um usuário desativado perde acesso operacional em TODO
-- o produto de uma vez, sem tocar em nenhuma policy individualmente.
--
-- CREATE OR REPLACE preserva owner/ACL (dono postgres; EXECUTE para
-- authenticated e service_role, herdados de 017/047).
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    JOIN accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND p.is_active
      AND a.is_active
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;

-- ============================================================
-- ENFORCE_PROFILE_PRIVILEGE_COLUMNS — agora também protege is_active
--
-- Mesmo raciocínio de 034: RLS restringe QUAIS linhas, não QUAIS
-- colunas. Sem esta extensão, o próprio usuário (ou qualquer colega
-- com permissão de UPDATE na própria linha) poderia reativar a si
-- mesmo via PATCH direto ao PostgREST. current_user continua sendo
-- o discriminador: as RPCs abaixo rodam como postgres (SECURITY
-- DEFINER), nunca como authenticated.
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.is_active IS DISTINCT FROM OLD.is_active)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role, account_id and is_active cannot be changed directly; use the account member/platform user RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger already exists from 034 and points at this function by
-- name — CREATE OR REPLACE above is enough, no need to re-bind it.

-- ============================================================
-- PLATFORM_ATTACH_USER_TO_ACCOUNT(...)
--
-- Vincula um usuário RECÉM-CRIADO via supabase.auth.admin.createUser()
-- à empresa correta, aplicando role/nome/filas em uma única
-- transação. Não é um "criar usuário" no sentido de auth.users — o
-- auth.users já existe quando esta função é chamada (criado pela
-- rota /api/admin/users no server, ANTES desta chamada); esta RPC
-- só governa o lado profiles/accounts/queue_members.
--
-- Pré-condição estrita (mesmo padrão de elegibilidade de
-- platform_create_account/047, aplicado à conta de ORIGEM): o
-- profile do usuário-alvo precisa estar EXATAMENTE na forma que
-- handle_new_user() sempre produz para um auth.users novo — dono
-- único de uma conta pessoal vazia, sem outros membros, sem dado
-- operacional. Qualquer desvio dessa forma (usuário pré-existente
-- com conta de verdade) é rejeitado sem tocar em nada — esta RPC
-- nunca "adota" um usuário já estabelecido em outra empresa.
--
-- Ao final, a conta pessoal temporária (agora vazia) é apagada — o
-- mesmo destino que redeem_invitation (019) já dá a uma conta pessoal
-- não utilizada.
-- ============================================================
CREATE OR REPLACE FUNCTION public.platform_attach_user_to_account(
  p_user_id UUID,
  p_account_id UUID,
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
  v_trimmed_name TEXT;
  v_temp_account_id UUID;
  v_current_role account_role_enum;
  v_other_member_count INTEGER;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'account_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_account_role IS NULL OR p_account_role NOT IN ('admin', 'agent') THEN
    RAISE EXCEPTION 'account_role must be admin or agent' USING ERRCODE = '22023';
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

  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = p_account_id AND is_active) THEN
    RAISE EXCEPTION 'Target account does not exist or is inactive' USING ERRCODE = '22023';
  END IF;

  -- Trava a linha de profile do alvo pela duração da transação —
  -- mesma técnica de platform_create_account, para que duas chamadas
  -- concorrentes visando o mesmo p_user_id não leiam o mesmo estado
  -- "elegível" e tentem anexá-lo duas vezes.
  SELECT account_id, account_role INTO v_temp_account_id, v_current_role
  FROM public.profiles WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_temp_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user has no profile to attach' USING ERRCODE = '22023';
  END IF;

  -- Defesa em profundidade: uma chamada incorreta nunca pode anexar o
  -- usuário à própria conta pessoal temporária que está prestes a ser
  -- apagada mais abaixo — isso deixaria o profile apontando para uma
  -- conta que este mesmo fluxo está prestes a remover.
  IF v_temp_account_id = p_account_id THEN
    RAISE EXCEPTION 'Target account must be different from the temporary personal account' USING ERRCODE = '22023';
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
    WHERE NOT EXISTS (SELECT 1 FROM public.queues q WHERE q.id = qid AND q.account_id = p_account_id)
  ) THEN
    RAISE EXCEPTION 'One or more queues do not belong to the target account' USING ERRCODE = '22023';
  END IF;

  -- Move o profile para a empresa alvo. Ignora
  -- enforce_profile_privilege_columns porque esta função roda como
  -- postgres (current_user = 'postgres'), não authenticated.
  UPDATE public.profiles
  SET account_id = p_account_id,
      account_role = p_account_role,
      full_name = v_trimmed_name,
      is_active = true
  WHERE user_id = p_user_id;

  -- A conta pessoal agora está vazia (seu único profile acabou de
  -- sair) e já foi confirmada sem dado operacional — seguro apagar,
  -- mesmo destino que redeem_invitation (019) já dá a esse formato de
  -- conta.
  DELETE FROM public.accounts WHERE id = v_temp_account_id;

  IF p_queue_ids IS NOT NULL THEN
    INSERT INTO public.queue_members (account_id, queue_id, user_id, role_in_queue)
    SELECT p_account_id, qid, p_user_id, 'agent'
    FROM unnest(p_queue_ids) qid
    ON CONFLICT (queue_id, user_id) DO NOTHING;
  END IF;

  INSERT INTO public.platform_audit_log (actor_user_id, action, target_account_id, target_user_id, metadata)
  VALUES (
    v_caller_id, 'platform_user.create', p_account_id, p_user_id,
    jsonb_build_object(
      'account_role', p_account_role,
      'queue_count', COALESCE(array_length(p_queue_ids, 1), 0)
    )
  );

  RETURN p_user_id;
END;
$$;

ALTER FUNCTION public.platform_attach_user_to_account(UUID, UUID, account_role_enum, TEXT, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_attach_user_to_account(UUID, UUID, account_role_enum, TEXT, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_attach_user_to_account(UUID, UUID, account_role_enum, TEXT, UUID[]) TO authenticated;

-- ============================================================
-- PLATFORM_UPDATE_USER(...)
--
-- Edita nome / papel / status / filas de um usuário de tenant
-- existente (admin ou agent — nunca owner, ver checagem abaixo).
-- Cada parâmetro NULL significa "não alterar", EXCETO p_queue_ids:
-- um array NÃO NULO (mesmo vazio '{}') substitui o conjunto de filas
-- inteiro; NULL deixa as filas como estão. A rota de API sempre passa
-- todos os parâmetros explicitamente (nunca depende de defaults do
-- PostgREST).
--
-- Nunca opera sobre um profile fora de admin/agent — owner é papel
-- técnico/estrutural (ver transfer_account_ownership, 018) e viewer
-- não é exposto nesta tela; ambos ficam fora do escopo desta
-- operação, checagem explícita logo abaixo (não depende só da API).
-- ============================================================
CREATE OR REPLACE FUNCTION public.platform_update_user(
  p_user_id UUID,
  p_full_name TEXT,
  p_account_role account_role_enum,
  p_is_active BOOLEAN,
  p_queue_ids UUID[]
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_account_id UUID;
  v_current_role account_role_enum;
  v_current_is_active BOOLEAN;
  v_trimmed_name TEXT;
  v_new_role account_role_enum;
  v_new_is_active BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required' USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role, is_active
    INTO v_account_id, v_current_role, v_current_is_active
  FROM public.profiles WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = '22023';
  END IF;

  -- Esta superfície só gerencia admin/agent — rejeita explicitamente
  -- qualquer outro papel atual (owner é técnico/estrutural; viewer
  -- não é exposto aqui), em vez de checar apenas o caso 'owner'. Não
  -- depende só da API para essa proteção: a própria RPC nega.
  IF v_current_role NOT IN ('admin', 'agent') THEN
    RAISE EXCEPTION
      'User is not managed by the platform user management operation'
      USING ERRCODE = '22023';
  END IF;

  IF p_account_role IS NOT NULL AND p_account_role NOT IN ('admin', 'agent') THEN
    RAISE EXCEPTION 'account_role must be admin or agent' USING ERRCODE = '22023';
  END IF;

  IF p_queue_ids IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(p_queue_ids) qid
    WHERE NOT EXISTS (SELECT 1 FROM public.queues q WHERE q.id = qid AND q.account_id = v_account_id)
  ) THEN
    RAISE EXCEPTION 'One or more queues do not belong to this user''s account' USING ERRCODE = '22023';
  END IF;

  IF p_full_name IS NOT NULL THEN
    v_trimmed_name := btrim(p_full_name);
    IF v_trimmed_name IS NULL OR length(v_trimmed_name) = 0 THEN
      RAISE EXCEPTION 'full_name cannot be empty' USING ERRCODE = '22023';
    END IF;
    IF length(v_trimmed_name) > 120 THEN
      RAISE EXCEPTION 'full_name must be 120 characters or fewer' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_new_role := COALESCE(p_account_role, v_current_role);
  v_new_is_active := COALESCE(p_is_active, v_current_is_active);

  UPDATE public.profiles
  SET full_name = COALESCE(v_trimmed_name, full_name),
      account_role = v_new_role,
      is_active = v_new_is_active
  WHERE user_id = p_user_id;

  IF p_queue_ids IS NOT NULL THEN
    DELETE FROM public.queue_members
    WHERE user_id = p_user_id AND account_id = v_account_id
      AND NOT (queue_id = ANY(p_queue_ids));

    INSERT INTO public.queue_members (account_id, queue_id, user_id, role_in_queue)
    SELECT v_account_id, qid, p_user_id, 'agent'
    FROM unnest(p_queue_ids) qid
    ON CONFLICT (queue_id, user_id) DO NOTHING;

    INSERT INTO public.platform_audit_log (actor_user_id, action, target_account_id, target_user_id, metadata)
    VALUES (v_caller_id, 'platform_user.queues_update', v_account_id, p_user_id,
            jsonb_build_object('queue_count', COALESCE(array_length(p_queue_ids, 1), 0)));
  END IF;

  IF p_full_name IS NOT NULL OR p_account_role IS NOT NULL THEN
    INSERT INTO public.platform_audit_log (actor_user_id, action, target_account_id, target_user_id, metadata)
    VALUES (v_caller_id, 'platform_user.update', v_account_id, p_user_id,
            jsonb_build_object('full_name_changed', p_full_name IS NOT NULL, 'account_role', v_new_role));
  END IF;

  IF p_is_active IS NOT NULL AND p_is_active IS DISTINCT FROM v_current_is_active THEN
    INSERT INTO public.platform_audit_log (actor_user_id, action, target_account_id, target_user_id, metadata)
    VALUES (v_caller_id,
            CASE WHEN p_is_active THEN 'platform_user.enable' ELSE 'platform_user.disable' END,
            v_account_id, p_user_id, '{}'::jsonb);
  END IF;
END;
$$;

ALTER FUNCTION public.platform_update_user(UUID, TEXT, account_role_enum, BOOLEAN, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_update_user(UUID, TEXT, account_role_enum, BOOLEAN, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_update_user(UUID, TEXT, account_role_enum, BOOLEAN, UUID[]) TO authenticated;
