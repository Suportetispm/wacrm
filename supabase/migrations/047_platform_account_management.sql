-- ============================================================
-- 047_platform_account_management
--
-- FASE 6C.2 — permite que o Superadmin (public.platform_admins, ver
-- 046_platform_admin_foundation.sql) crie e gerencie empresas/tenants
-- sem depender do signup público.
--
-- AUDITORIA PRÉVIA (resumo, ver resposta da fase para o detalhe):
--   - accounts hoje: id, name, owner_user_id (NOT NULL, ON DELETE
--     RESTRICT), created_at, updated_at, default_currency;
--   - a ÚNICA forma de uma linha nascer em accounts hoje é o trigger
--     handle_new_user() (AFTER INSERT ON auth.users), disparado a
--     cada signup público — não existe rota/RPC de "criar empresa";
--   - owner_user_id continua obrigatório nesta migration — não é
--     relaxado para NULL. Justificativa: é o pilar de várias
--     invariantes já existentes (idx_accounts_one_per_owner,
--     transfer_account_ownership, proteção "sempre tem 1 owner") e
--     nenhum requisito desta fase pede empresa sem dono;
--   - decisão: "empresa não nasce órfã" -> platform_create_account
--     abaixo cria accounts + vincula o primeiro owner numa única
--     transação (a função inteira roda em uma transação implícita).
--
-- NESTA FASE:
--   - accounts ganha is_active/disabled_at (status da empresa);
--   - is_account_member() passa a exigir accounts.is_active = true
--     (ver justificativa detalhada mais abaixo — decisão de
--     arquitetura consciente, não um efeito colateral);
--   - platform_create_account / platform_update_account /
--     platform_set_account_active: RPCs SECURITY DEFINER, mesmo
--     padrão de auto-checagem de 046;
--   - NÃO cria tela /admin, NÃO cria atendentes, NÃO altera
--     account_role_enum, queues, tickets, inbox ou migration 046.
-- ------------------------------------------------------------

-- ============================================================
-- ACCOUNTS — status da empresa
--
-- Mesmo padrão já usado em queues (039_queues_and_members.sql):
-- is_active + disabled_at, nunca exclusão física. Empresa desativada
-- não perde nenhuma linha — só fica inacessível para uso operacional
-- (ver is_account_member() abaixo).
-- ============================================================
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ NULL;

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_disabled_at_consistency;

ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_disabled_at_consistency
  CHECK (disabled_at IS NULL OR NOT is_active);

CREATE INDEX IF NOT EXISTS idx_accounts_is_active ON public.accounts(is_active);

-- ============================================================
-- IS_ACCOUNT_MEMBER() — agora também exige accounts.is_active
--
-- DECISÃO DE ARQUITETURA (não é um efeito colateral acidental):
--
-- O requisito desta fase é "empresa inativa deve bloquear uso
-- operacional do tenant". Isso só pode ser garantido de verdade no
-- nível de RLS, e não só na camada de API do Next.js
-- (getCurrentAccount()/requireRole() em src/lib/auth/account.ts):
-- uma varredura do código confirma que dezenas de componentes client
-- (inbox, contacts, broadcasts, pipelines, dashboard, settings, etc.)
-- consultam o Supabase diretamente do navegador via `.from(...)`,
-- sem passar por nenhuma rota /api/**. Um bloqueio só na camada de
-- API deixaria todo esse caminho aberto — uma empresa "desativada"
-- continuaria plenamente utilizável por quem já está logado.
--
-- is_account_member() é a única primitiva chamada por praticamente
-- toda policy de RLS do produto (contacts, conversations, deals,
-- tags, automations, flows, queues, tickets, etc. — nenhuma dessas
-- tabelas ou suas próprias migrations são alteradas aqui; só esta
-- função, que elas já chamam). Adicionar a checagem de is_active uma
-- única vez aqui propaga o bloqueio para todo o produto de forma
-- consistente, em vez de precisar tocar dezenas de policies uma a
-- uma — e sem alterar nenhuma tabela de queues/tickets/inbox.
--
-- Efeito colateral aceito e documentado: como accounts_select
-- também usa is_account_member(), os próprios membros de uma empresa
-- desativada deixam de conseguir ler até o nome/dados da própria
-- conta pela via normal. Do ponto de vista de
-- getCurrentAccount()/requireRole(), isso é indistinguível de
-- "profile não vinculado a nenhuma conta" — mesma mensagem genérica
-- que já existe hoje para outros casos (profile órfão, RLS gap).
-- Deliberado: evita vazar "esta empresa existe e está desativada"
-- para alguém investigando o sistema.
--
-- service_role continua bypassando RLS por definição, então as
-- rotas administrativas do Superadmin (que usam service_role, nunca
-- este helper) nunca são afetadas por esta checagem — o Superadmin
-- sempre consegue reativar uma empresa desativada.
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

-- CREATE OR REPLACE preserva owner/ACL quando a assinatura não muda
-- (não muda aqui) — dono e GRANTs continuam os mesmos definidos em
-- 017_account_sharing.sql (postgres; EXECUTE para authenticated e
-- service_role).

-- ============================================================
-- ACCOUNT_HAS_ANY_DATA(p_account_id)
--
-- Responde apenas "esta conta tem DADOS OPERACIONAIS?" — uma
-- distinção deliberada de "esta conta tem outros membros?", que
-- platform_create_account checa separadamente (ver mais abaixo).
--
-- DADOS ESTRUTURAIS — permitidos numa conta pessoal elegível para
-- conversão, NUNCA bloqueiam:
--   - a própria linha de accounts (não tem coluna account_id, nem
--     seria pega por este scan — é a conta, não é "dado da conta");
--   - a própria linha de profiles do owner (única exclusão explícita
--     abaixo — é a linha de membership que platform_create_account
--     está reaproveitando como parte da própria operação, não "dado
--     de domínio". Outras linhas de profiles — ou seja, OUTROS
--     membros — são tratadas à parte, não por esta função).
--
-- DADOS OPERACIONAIS — qualquer linha aqui bloqueia a conversão:
--   contacts, conversations, messages (via conversation_id — ver
--   nota sobre cascade abaixo), broadcasts, pipelines/deals,
--   whatsapp_config, automations, flows, queues, queue_members,
--   tickets, api_keys, webhook_endpoints, ai_reply_settings/
--   ai_knowledge_*, account_invitations, e qualquer tabela futura que
--   siga a mesma convenção — coberto pelo scan dinâmico abaixo, sem
--   lista fixa (ver nota histórica).
--
-- REVISÃO (FASE 6C.2, revisão bloqueante) — nota histórica: a
-- primeira versão desta migration comparava contra uma lista fixa de
-- 11 tabelas copiada de redeem_invitation (019_invitation_rpcs.sql),
-- já desatualizada na própria 019 (não cobria deals, automation_logs,
-- automation_pending_executions, flow_runs, com account_id desde a
-- 017) e mais defasada depois: queues/queue_members (039), tickets/
-- ticket_events/ticket_settings (040/041), api_keys (026),
-- notifications (027), webhook_endpoints (028), ai_reply_settings/
-- ai_knowledge_* (029/030/032/033), member_presence (024),
-- interactive_messages (035), account_invitations (017). Uma conta
-- com dados só nessas tabelas seria tratada como "vazia" e apagada.
--
-- Esta versão não mantém lista nenhuma: descobre em tempo de
-- execução, via information_schema, toda tabela em public que tem
-- uma coluna account_id, e verifica cada uma.
--
-- Referências indiretas / cascade (avaliado explicitamente): nem
-- toda tabela dependente da conta tem sua PRÓPRIA coluna account_id
-- — ex.: automation_steps (referencia automation_id, não account_id
-- diretamente), contact_tags/contact_custom_values (referenciam
-- contact_id), messages (referencia conversation_id). Este scan não
-- as visita diretamente, mas isso não é uma lacuna: cada uma delas só
-- pode existir referenciando uma linha em uma tabela PAI que TEM
-- account_id (automations, contacts, conversations, respectivamente)
-- via foreign key. Se o scan confirma que todas as tabelas com
-- account_id direto estão vazias para esta conta, nenhuma linha pai
-- existe para essas tabelas filhas referenciarem — logo elas também
-- estão garantidamente vazias, por integridade referencial, sem
-- precisar visitá-las uma a uma. Esse argumento depende de todo
-- schema filho estar de fato FK'd a uma tabela pai com account_id
-- (verdadeiro para todas as tabelas conhecidas nesta auditoria) —
-- recomenda-se reconfirmar contra o schema real antes de aplicar.
--
-- Sem GRANT para authenticated de propósito — só é chamada de dentro
-- de outras funções SECURITY DEFINER já autorizadas (o dono postgres
-- sempre pode executar suas próprias funções, independente deste
-- REVOKE, que só restringe outras roles). Nenhum authenticated comum
-- deve conseguir sondar "esta conta X tem dados?" diretamente.
-- ============================================================
CREATE OR REPLACE FUNCTION public.account_has_any_data(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_table RECORD;
  v_found BOOLEAN;
BEGIN
  FOR v_table IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'account_id'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name <> 'profiles'
  LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%I WHERE account_id = $1)',
      v_table.table_name
    ) INTO v_found USING p_account_id;

    IF v_found THEN
      RETURN TRUE;
    END IF;
  END LOOP;

  RETURN FALSE;
END;
$$;

ALTER FUNCTION public.account_has_any_data(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_has_any_data(UUID) FROM PUBLIC;

-- ============================================================
-- PLATFORM_CREATE_ACCOUNT(p_name, p_owner_user_id)
--
-- Cria uma empresa nova com um owner já definido, atomicamente —
-- nunca uma accounts órfã sem dono. p_owner_user_id precisa já
-- existir em auth.users (estratégia A da fase: usuário já existente
-- — ver docs/platform-admin-bootstrap.md para o mesmo padrão de
-- "a pessoa faz signup normal, o Superadmin descobre o UUID depois").
-- Criação/convite de usuário direto pela Admin API do Supabase
-- (estratégia B) fica para uma fase futura (6C.3); esta RPC já está
-- pronta para receber, nesse momento, um p_owner_user_id recém-criado
-- por aquele fluxo sem precisar mudar assinatura.
--
-- REVISÃO FINAL (FASE 6C.2, segunda revisão bloqueante) — a versão
-- anterior desta função apagava a conta pessoal antiga e criava uma
-- conta NOVA em seu lugar (com um account_id novo). Preferência
-- definitiva do produto: NUNCA apagar/recriar quando a conta antiga
-- for elegível — reaproveitar a MESMA linha de accounts, preservando
-- accounts.id, owner_user_id e profiles.account_id/account_role, só
-- trocando o nome. Motivos: evita o DELETE ON CASCADE inteiramente
-- (nenhum risco transacional de perder o profile no meio do
-- caminho), preserva qualquer referência externa que já tenha
-- guardado o account_id (ex.: integrações), e reduz drasticamente a
-- superfície da operação.
--
-- Dois caminhos, mutuamente exclusivos:
--
--   A. Sem profile ainda (situação excepcional — trigger de signup
--      falhou/foi pulado): cria accounts + profiles do zero,
--      atomicamente. account 'platform_account.create'.
--
--   B. Já tem profile: só é ELEGÍVEL para conversão (reaproveitar a
--      linha) se TODAS as condições abaixo valerem — qualquer uma
--      que falhe rejeita a operação inteira, sem modificar nada:
--        1. profiles.account_role = 'owner' — o usuário precisa ser
--           dono da própria conta, não um membro convidado de uma
--           empresa alheia (cuja role nunca é 'owner', garantido
--           pelo CHECK em account_invitations.role <> 'owner' desde
--           017). Nunca reaproveitamos uma conta que não é dele.
--        2. accounts.owner_user_id da conta bate com o usuário-alvo
--           — checagem redundante defensiva sobre a invariante que
--           (1) já implica, mantida por set_member_role/
--           transfer_account_ownership desde 018.
--        3. Nenhum OUTRO profile aponta para essa conta — ou seja,
--           ele é o único membro. Isto é "dado estrutural" no
--           sentido de que uma conta com só o dono ainda não virou
--           um time de verdade; ter outros membros já é atividade
--           real e desqualifica o reaproveitamento silencioso.
--        4. account_has_any_data() (acima) retorna false — nenhum
--           dado operacional em nenhuma tabela account_id-scoped
--           (exceto profiles, tratado no item 3).
--      Se elegível: UPDATE accounts.name na MESMA linha — accounts.id,
--      owner_user_id e profiles.account_id/account_role permanecem
--      idênticos, nada é apagado ou recriado. Ação
--      'platform_account.convert'.
--      Se qualquer condição falhar: RAISE EXCEPTION sanitizado (sem
--      vazar o account_id), nada é modificado.
--
-- SELECT ... FOR UPDATE na linha de profile trava a leitura da conta
-- atual pela duração da transação, para que duas chamadas
-- concorrentes visando o mesmo p_owner_user_id não leiam o mesmo
-- estado e tentem convertê-lo duas vezes.
-- ============================================================
CREATE OR REPLACE FUNCTION public.platform_create_account(
  p_name TEXT,
  p_owner_user_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_trimmed_name TEXT;
  v_new_account_id UUID;
  v_profile_account_id UUID;
  v_profile_role account_role_enum;
  v_other_member_count INTEGER;
  v_action TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  v_trimmed_name := btrim(p_name);
  IF v_trimmed_name IS NULL OR length(v_trimmed_name) = 0 THEN
    RAISE EXCEPTION 'name is required' USING ERRCODE = '22023';
  END IF;
  IF length(v_trimmed_name) > 80 THEN
    RAISE EXCEPTION 'name must be 80 characters or fewer' USING ERRCODE = '22023';
  END IF;

  IF p_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'owner_user_id is required' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_owner_user_id) THEN
    RAISE EXCEPTION 'Target user does not exist' USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role INTO v_profile_account_id, v_profile_role
  FROM public.profiles WHERE user_id = p_owner_user_id
  FOR UPDATE;

  IF v_profile_account_id IS NULL THEN
    -- Caminho A: bootstrap do zero.
    INSERT INTO public.accounts (name, owner_user_id)
    VALUES (v_trimmed_name, p_owner_user_id)
    RETURNING id INTO v_new_account_id;

    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    SELECT p_owner_user_id,
           COALESCE(u.raw_user_meta_data->>'full_name', ''),
           u.email,
           v_new_account_id,
           'owner'
    FROM auth.users u
    WHERE u.id = p_owner_user_id;

    v_action := 'platform_account.create';
  ELSE
    -- Caminho B: candidato a conversão — valida as 4 condições antes
    -- de tocar em qualquer coisa.
    IF v_profile_role <> 'owner' THEN
      RAISE EXCEPTION 'Target user already belongs to an existing account they do not own; cannot convert it' USING ERRCODE = '23505';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.accounts
      WHERE id = v_profile_account_id AND owner_user_id = p_owner_user_id
    ) THEN
      RAISE EXCEPTION 'Target user account ownership is inconsistent; refusing to convert it' USING ERRCODE = '23505';
    END IF;

    SELECT count(*) INTO v_other_member_count
    FROM public.profiles
    WHERE account_id = v_profile_account_id AND user_id <> p_owner_user_id;

    IF v_other_member_count > 0 THEN
      RAISE EXCEPTION 'Target user existing account already has other members; cannot convert it' USING ERRCODE = '23505';
    END IF;

    IF public.account_has_any_data(v_profile_account_id) THEN
      RAISE EXCEPTION 'Target user existing account already has operational data; cannot convert it' USING ERRCODE = '23505';
    END IF;

    -- Elegível: reaproveita a MESMA linha — nenhum DELETE, nenhum
    -- profile recriado. accounts.id, owner_user_id e
    -- profiles.account_id/account_role permanecem exatamente iguais.
    UPDATE public.accounts SET name = v_trimmed_name WHERE id = v_profile_account_id;
    v_new_account_id := v_profile_account_id;
    v_action := 'platform_account.convert';
  END IF;

  INSERT INTO public.platform_audit_log (actor_user_id, action, target_account_id, target_user_id, metadata)
  VALUES (v_caller_id, v_action, v_new_account_id, p_owner_user_id, '{}'::jsonb);

  RETURN v_new_account_id;
END;
$$;

ALTER FUNCTION public.platform_create_account(TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_create_account(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_create_account(TEXT, UUID) TO authenticated;

-- ============================================================
-- PLATFORM_UPDATE_ACCOUNT(p_account_id, p_name)
--
-- Edita o nome de uma empresa. Mesma validação de tamanho/vazio já
-- usada em PATCH /api/account (tenant-scoped) para consistência de
-- regra de negócio, mas totalmente independente daquela rota — esta
-- não passa por requireRole()/is_account_member(), só por
-- is_platform_admin().
-- ============================================================
CREATE OR REPLACE FUNCTION public.platform_update_account(
  p_account_id UUID,
  p_name TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_trimmed_name TEXT;
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

  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = p_account_id) THEN
    RAISE EXCEPTION 'Account not found' USING ERRCODE = '22023';
  END IF;

  v_trimmed_name := btrim(p_name);
  IF v_trimmed_name IS NULL OR length(v_trimmed_name) = 0 THEN
    RAISE EXCEPTION 'name is required' USING ERRCODE = '22023';
  END IF;
  IF length(v_trimmed_name) > 80 THEN
    RAISE EXCEPTION 'name must be 80 characters or fewer' USING ERRCODE = '22023';
  END IF;

  UPDATE public.accounts SET name = v_trimmed_name WHERE id = p_account_id;

  -- metadata carrega o novo nome (não é secret) — dá valor real à
  -- auditoria sem risco.
  INSERT INTO public.platform_audit_log (actor_user_id, action, target_account_id, metadata)
  VALUES (v_caller_id, 'platform_account.update', p_account_id, jsonb_build_object('name', v_trimmed_name));
END;
$$;

ALTER FUNCTION public.platform_update_account(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_update_account(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_update_account(UUID, TEXT) TO authenticated;

-- ============================================================
-- PLATFORM_SET_ACCOUNT_ACTIVE(p_account_id, p_is_active)
--
-- Ativa/desativa uma empresa. Nunca apaga nenhuma linha — só alterna
-- is_active/disabled_at, que é o que is_account_member() acima passa
-- a checar. Uma única função para os dois sentidos (em vez de
-- enable/disable separadas) para não duplicar a validação; a ação de
-- auditoria registrada difere conforme o sentido.
-- ============================================================
CREATE OR REPLACE FUNCTION public.platform_set_account_active(
  p_account_id UUID,
  p_is_active BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_action TEXT;
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

  IF p_is_active IS NULL THEN
    RAISE EXCEPTION 'is_active is required' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = p_account_id) THEN
    RAISE EXCEPTION 'Account not found' USING ERRCODE = '22023';
  END IF;

  UPDATE public.accounts
  SET is_active = p_is_active,
      disabled_at = CASE WHEN p_is_active THEN NULL ELSE now() END
  WHERE id = p_account_id;

  v_action := CASE WHEN p_is_active THEN 'platform_account.enable' ELSE 'platform_account.disable' END;

  INSERT INTO public.platform_audit_log (actor_user_id, action, target_account_id, metadata)
  VALUES (v_caller_id, v_action, p_account_id, '{}'::jsonb);
END;
$$;

ALTER FUNCTION public.platform_set_account_active(UUID, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_set_account_active(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_set_account_active(UUID, BOOLEAN) TO authenticated;
