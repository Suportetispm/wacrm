-- ============================================================
-- 056_account_member_direct_creation
--
-- Adiciona um segundo caminho, paralelo ao convite (017/018/019),
-- para colocar alguém dentro da própria account: o owner/admin cria
-- o login diretamente (nome + e-mail + senha + função + filas), sem
-- passar por link de convite. O convite continua existindo e
-- funcional — esta RPC não o substitui, só oferece uma alternativa
-- síncrona para quando o admin já sabe o e-mail/senha da pessoa.
--
-- Mesmo molde de auditoria/estrutura de platform_attach_user_to_
-- account (048), mas com uma diferença estrutural deliberada: aqui
-- NÃO existe parâmetro p_account_id. A conta de destino é sempre a
-- do CHAMADOR, resolvida internamente via auth.uid() — o mesmo
-- padrão de set_member_role/remove_account_member (018). Isso torna
-- estruturalmente impossível a um account admin anexar alguém a uma
-- empresa que não é a sua, mesmo que a camada de API tivesse um bug
-- — a garantia vive na RPC, não só na rota.
--
-- Pré-condição de elegibilidade do usuário-alvo idêntica à de
-- platform_attach_user_to_account: precisa estar exatamente na
-- forma que handle_new_user() (017) sempre produz para um auth.users
-- novo — dono único de uma conta pessoal vazia, sem outros membros,
-- sem dado operacional (account_has_any_data(), 052/055). Qualquer
-- desvio é rejeitado sem tocar em nada.
--
-- account_role aceita admin/agent/viewer — nunca owner (papel
-- técnico/estrutural, só muda via transfer_account_ownership, 018).
--
-- O auth.users em si é criado pela rota POST /api/account/members
-- ANTES desta chamada, via admin.auth.admin.createUser() (mesmo
-- padrão de /api/admin/users) — esta RPC só governa
-- profiles/accounts/queue_members.
--
-- Idempotente — seguro rodar mais de uma vez (CREATE OR REPLACE).
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

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
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

-- ============================================================
-- OWNER / SECURITY
--
-- authenticated precisa de EXECUTE porque a rota (POST /api/account/
-- members) chama esta RPC via ctx.supabase — o client RLS-scoped da
-- sessão real do chamador, autenticado como `authenticated`. Isso é
-- seguro porque a função nunca confia nesse papel de banco para
-- decidir QUEM é o chamador ou QUAL é a conta-alvo: auth.uid() é
-- resolvido a partir do JWT da própria sessão (não de um parâmetro),
-- e toda a checagem de privilégio (owner/admin, conta ativa) roda
-- DEPOIS disso, dentro do corpo da função. Ter EXECUTE só abre a
-- porta para chamar a função; as regras de negócio de dentro dela
-- continuam valendo para qualquer `authenticated` que chamar.
--
-- anon e service_role NUNCA precisam chamar esta RPC:
--   - anon não tem auth.uid() (sempre NULL) — cairia direto no
--     primeiro RAISE EXCEPTION 'Unauthorized', mesmo que tivesse
--     EXECUTE. Ainda assim, o EXECUTE é revogado explicitamente
--     abaixo — defesa em profundidade, não depende só desse efeito
--     colateral.
--   - service_role nunca chama RPCs SECURITY DEFINER como esta no
--     código da aplicação (a rota usa o client service_role só para
--     admin.auth.admin.createUser() e para a compensação de rollback,
--     nunca para esta RPC) — não há caso de uso legítimo, então o
--     EXECUTE é revogado.
-- ============================================================

ALTER FUNCTION public.create_account_member(UUID, account_role_enum, TEXT, UUID[]) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_account_member(UUID, account_role_enum, TEXT, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_account_member(UUID, account_role_enum, TEXT, UUID[]) FROM anon;
REVOKE ALL ON FUNCTION public.create_account_member(UUID, account_role_enum, TEXT, UUID[]) FROM service_role;

GRANT EXECUTE ON FUNCTION public.create_account_member(UUID, account_role_enum, TEXT, UUID[]) TO authenticated;

-- ============================================================
-- VALIDAÇÃO MANUAL
-- ============================================================
--
-- A. Função existe, dono correto, SECURITY DEFINER:
--
-- SELECT p.proname, r.rolname AS owner, p.prosecdef
-- FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
-- WHERE p.pronamespace = 'public'::regnamespace
--   AND p.proname = 'create_account_member';
--
-- Esperado: owner = postgres, prosecdef = true
--
--
-- B. Grants — só authenticated tem EXECUTE:
--
-- SELECT grantee, privilege_type
-- FROM information_schema.routine_privileges
-- WHERE routine_schema = 'public'
--   AND routine_name = 'create_account_member'
-- ORDER BY grantee;
--
-- Esperado: uma única linha, grantee = authenticated,
-- privilege_type = EXECUTE. Nenhuma linha para PUBLIC, anon ou
-- service_role.
--
--
-- C. admin/owner consegue criar (via app): logado como admin OU
--    owner de uma conta, "Criar usuário" com um e-mail novo → 201,
--    usuário aparece imediatamente em Membros da equipe.
--
--
-- D. agent/viewer NÃO conseguem criar: logado como agent ou como
--    viewer, chamar POST /api/account/members (ou a RPC direto) →
--    403 "This action requires the admin role or higher", nenhuma
--    linha tocada.
--
--
-- E. owner não pode ser atribuído como nova role: chamar com
--    p_account_role = 'owner' → rejeitado. A rota já bloqueia isso
--    em 400 antes de chegar aqui (CREATABLE_ROLES não inclui
--    'owner'); testar a RPC diretamente confirma que o bloqueio
--    também existe em SQL, não só na API:
--
-- SELECT create_account_member('<user-id>', 'owner', 'Teste', NULL);
-- Esperado: ERRO 22023 "account_role must be admin, agent or viewer"
--
--
-- F. Queue de outra account é rejeitada:
--
-- SELECT create_account_member('<user-id>', 'agent', 'Teste',
--   ARRAY['<queue-id-de-outra-account>']::uuid[]);
-- Esperado: ERRO 22023 "One or more queues do not belong to your account"
--
--
-- G. Profile termina na account correta:
--
-- SELECT account_id, account_role FROM public.profiles
-- WHERE user_id = '<user-id>';
-- Esperado: account_id = a conta do chamador (nunca outra).
--
--
-- H. Conta temporária é removida:
--
-- SELECT * FROM public.accounts WHERE id = '<temp-account-id-antiga>';
-- Esperado: 0 linhas.
--
--
-- I. Nenhuma account extra permanece — regressão de contagem total:
--
-- SELECT count(*) FROM public.accounts; -- antes e depois do fluxo: igual
-- (a temporária criada por handle_new_user() é removida pela própria
-- função; nenhuma conta nova fica para trás).
--
--
-- J. Usuário aparece imediatamente em Membros da equipe (via app):
--    GET /api/account/members logo após o POST retorna o novo
--    usuário na lista, sem precisar de refresh/reload de sessão.
