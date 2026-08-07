-- ============================================================
-- 046_platform_admin_foundation
--
-- FASE 6C.1 — infraestrutura de autorização do Superadmin da
-- plataforma (public.platform_admins), completamente separada dos
-- papéis de tenant (owner/admin/agent/viewer em account_role_enum).
--
-- Superadmin tem escopo de PLATAFORMA, não de uma conta especifica:
-- por isso ele NÃO é mais um valor de account_role_enum e NÃO é uma
-- coluna em profiles (que é uma tabela por-conta, lida por qualquer
-- colega de conta via a policy profiles_select — colocar um flag
-- global ali vazaria a informação para colegas de trabalho e
-- repetiria a classe de bug que a migration 034 corrigiu). Também
-- não usa custom claims do Supabase Auth: um claim já emitido num
-- JWT continua válido até o token expirar/renovar mesmo depois de
-- revogado no banco, e a configuração de um Auth Hook fica fora
-- deste repositório, invisível num `git diff` — inaceitável para um
-- flag deste nível de sensibilidade num deploy self-hosted.
--
-- NESTA FASE:
--   - cria public.platform_admins e public.platform_audit_log;
--   - cria is_platform_admin() e as RPCs grant/revoke_platform_admin;
--   - NÃO cria tela /admin, NÃO cria empresas, NÃO cria usuários;
--   - NÃO altera account_role_enum, profiles, queues ou tickets.
--
-- Bootstrap do primeiro Superadmin: NÃO é feito por esta migration
-- (não pode depender de grant_platform_admin, que exige que o
-- chamador já seja platform admin — ver docs/platform-admin-
-- bootstrap.md para o procedimento manual).
-- ------------------------------------------------------------

-- ============================================================
-- PLATFORM_ADMINS
--
-- Uma linha por usuário com escopo de plataforma. RLS habilitada e
-- SEM NENHUMA policy para authenticated/anon — isso não é um
-- esquecimento, é a proteção: RLS com zero policies nega toda leitura
-- e escrita para essas roles por padrão no Postgres, então o acesso
-- direto do navegador via PostgREST fica impossível independentemente
-- de qualquer GRANT de schema que o Supabase aplique globalmente. O
-- único jeito de ler/escrever esta tabela é:
--   a) service_role (bypassa RLS por definição, uso restrito a
--      código server-only administrativo em fases futuras);
--   b) funções SECURITY DEFINER explicitamente autorizadas abaixo
--      (is_platform_admin, grant_platform_admin, revoke_platform_admin).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.platform_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE RESTRICT (não CASCADE): se fosse CASCADE, apagar o
  -- auth.users do último Superadmin apagaria silenciosamente esta
  -- linha junto — contornando por completo a proteção de
  -- revoke_platform_admin() contra zerar platform_admins, já que uma
  -- exclusão de usuário nunca passa por aquela RPC. Com RESTRICT, o
  -- Postgres recusa a exclusão em auth.users enquanto a linha aqui
  -- existir; é preciso revogar o acesso explicitamente primeiro (o
  -- que já aciona a checagem de "não é o último"). Mesmo raciocínio
  -- já aplicado a accounts.owner_user_id em 017_account_sharing.sql.
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Quem concedeu o acesso. SET NULL (não CASCADE nem RESTRICT)
  -- porque a saída do concedente do sistema não deve apagar nem
  -- bloquear a exclusão do registro de que o alvo é (ou foi)
  -- Superadmin — só perde a referência de quem concedeu.
  created_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL
);

-- user_id já tem índice único implícito pela constraint UNIQUE acima;
-- nenhum índice adicional é necessário para uma tabela deste tamanho
-- e padrão de acesso (sempre por user_id, nunca por created_at aqui).

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

-- Nenhuma policy é criada de propósito — ver comentário acima.

-- Defesa em profundidade além da RLS: mesmo que uma policy seja
-- adicionada por engano no futuro, ou que o GRANT de schema padrão
-- do Supabase para estas roles mude, o REVOKE explícito abaixo
-- garante que PUBLIC/anon/authenticated não têm privilégio algum
-- (SELECT/INSERT/UPDATE/DELETE) sobre a tabela em si — só as funções
-- SECURITY DEFINER (que rodam como o dono da tabela) conseguem
-- tocá-la. service_role não é revogado aqui: ele bypassa RLS por
-- definição e é o caminho legítimo para operações administrativas
-- server-only de fases futuras.
REVOKE ALL ON TABLE public.platform_admins FROM PUBLIC;
REVOKE ALL ON TABLE public.platform_admins FROM anon;
REVOKE ALL ON TABLE public.platform_admins FROM authenticated;

-- ============================================================
-- PLATFORM_AUDIT_LOG
--
-- Log de auditoria de ações administrativas de escopo de plataforma.
-- Mesma postura de RLS que platform_admins: habilitada, sem policy
-- para authenticated/anon — nem leitura nem escrita diretas. Toda
-- gravação acontece de dentro das próprias funções SECURITY DEFINER
-- (grant_platform_admin, revoke_platform_admin, e futuramente as
-- RPCs de criação de empresa/usuário da FASE 6C.2/6C.3), nunca por
-- INSERT direto do cliente.
--
-- metadata é JSONB livre para contexto adicional por ação, mas NUNCA
-- deve conter senha, access token, refresh token, API key, service
-- role key, token de convite em texto puro, ou qualquer outro
-- secret — as funções desta migration só gravam '{}'::jsonb, e essa
-- disciplina precisa ser mantida por qualquer função futura que
-- escreva aqui.
-- ============================================================
-- NOTA (revisão de segurança, ainda não implementada): actor_user_id,
-- target_user_id e target_account_id usam ON DELETE SET NULL abaixo.
-- Isso preserva a linha do log mas perde o identificador histórico
-- quando o usuário/conta referenciado é apagado — para um log cuja
-- função é justamente accountability, isso é uma lacuna real (ex.:
-- um Superadmin que apaga dados e depois é removido do sistema
-- desaparece do próprio rastro que deixou). Avaliado e não corrigido
-- nesta migration por pedido explícito de revisão — ver recomendação
-- (colunas de snapshot: actor_email, target_user_email,
-- target_account_name, capturadas no momento do INSERT) a ser
-- decidida e implementada em 6C.2/6C.3, quando as RPCs que de fato
-- populam metadata com contexto significativo forem criadas.
CREATE TABLE IF NOT EXISTS public.platform_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SET NULL (não CASCADE): a saída do ator do sistema não deve
  -- apagar o histórico do que ele fez.
  actor_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  -- SET NULL: exclusão de uma conta ou de um usuário-alvo não deve
  -- apagar o registro de auditoria correspondente, só desvincular a
  -- referência.
  target_account_id UUID NULL REFERENCES public.accounts(id) ON DELETE SET NULL,
  target_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Log de auditoria é lido quase sempre em ordem cronológica reversa
-- (mais recente primeiro) — índice justificado desde já, mesmo sem UI
-- ainda, porque é o padrão de acesso natural de qualquer tabela de log.
CREATE INDEX IF NOT EXISTS idx_platform_audit_log_created_at
  ON public.platform_audit_log (created_at DESC);

ALTER TABLE public.platform_audit_log ENABLE ROW LEVEL SECURITY;

-- Nenhuma policy é criada de propósito — ver comentário acima.

-- Defesa em profundidade além da RLS — mesmo raciocínio de
-- platform_admins acima. service_role não é revogado.
REVOKE ALL ON TABLE public.platform_audit_log FROM PUBLIC;
REVOKE ALL ON TABLE public.platform_audit_log FROM anon;
REVOKE ALL ON TABLE public.platform_audit_log FROM authenticated;

-- ============================================================
-- IS_PLATFORM_ADMIN()
--
-- Primitiva de leitura usada por toda checagem de autorização de
-- plataforma (equivalente, em espírito, ao is_account_member() já
-- usado para tenant em 017_account_sharing.sql).
--
-- SECURITY DEFINER é obrigatório aqui: platform_admins não tem
-- nenhuma policy para authenticated, então uma função SECURITY
-- INVOKER rodando com o privilégio do chamador bateria na mesma
-- parede de RLS e sempre veria zero linhas — o ponto desta função é
-- justamente permitir uma leitura estreita e controlada (só "sou eu
-- platform admin?", nada mais) sem abrir a tabela inteira para leitura
-- direta.
--
-- Nunca aceita user_id como argumento — sempre auth.uid() do
-- chamador. Isso fecha por construção qualquer tentativa de perguntar
-- "fulano é platform admin?" para descobrir a lista de Superadmins
-- por tentativa e erro a partir do cliente.
--
-- Grant só para authenticated: a função inteira gira em torno de
-- auth.uid(), que representa a sessão do usuário autenticado atual.
-- Rodando como service_role não existe essa sessão — auth.uid()
-- resolve NULL e a função sempre retornaria false, então não há
-- nenhum uso legítimo de EXECUTE por service_role aqui. Se um código
-- server-only futuro precisar checar platform_admins fora de uma
-- sessão de usuário (ex.: um job administrativo), ele consulta a
-- tabela diretamente com service_role (que já bypassa RLS por
-- definição) em vez de chamar esta função.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid()
  );
$$;

ALTER FUNCTION public.is_platform_admin() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_platform_admin() FROM anon;
REVOKE ALL ON FUNCTION public.is_platform_admin() FROM service_role;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated;

-- ============================================================
-- GRANT_PLATFORM_ADMIN(p_target_user_id)
--
-- Único caminho para conceder acesso de Superadmin a alguém, fora do
-- bootstrap manual documentado em docs/platform-admin-bootstrap.md.
-- Auto-checagem: o chamador precisa já ser platform admin — nenhum
-- authenticated comum consegue se auto-promover, pelo mesmo motivo
-- estrutural que set_member_role (018_account_member_rpcs.sql) não
-- deixa um agent virar admin sozinho.
--
-- Códigos de erro seguem a convenção já usada nas RPCs de conta:
--   42501 (insufficient_privilege) — não autenticado ou sem
--          privilégio de platform admin.
--   22023 (invalid_parameter_value) — entrada inválida.
--   23505 (unique_violation)        — já é platform admin.
-- Mensagens nunca incluem o UUID do alvo, só a natureza do erro.
-- ============================================================
CREATE OR REPLACE FUNCTION public.grant_platform_admin(p_target_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'target_user_id is required' USING ERRCODE = '22023';
  END IF;

  -- O alvo precisa existir em auth.users — nunca cria uma linha órfã
  -- em platform_admins apontando para um usuário inexistente.
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_target_user_id) THEN
    RAISE EXCEPTION 'Target user does not exist' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = p_target_user_id) THEN
    RAISE EXCEPTION 'User is already a platform admin' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.platform_admins (user_id, created_by)
  VALUES (p_target_user_id, v_caller_id);

  INSERT INTO public.platform_audit_log (actor_user_id, action, target_user_id, metadata)
  VALUES (v_caller_id, 'platform_admin.grant', p_target_user_id, '{}'::jsonb);
END;
$$;

ALTER FUNCTION public.grant_platform_admin(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.grant_platform_admin(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.grant_platform_admin(UUID) TO authenticated;

-- ============================================================
-- REVOKE_PLATFORM_ADMIN(p_target_user_id)
--
-- Mesma auto-checagem de grant_platform_admin, mais a proteção do
-- último Superadmin: nunca deixa platform_admins chegar a zero
-- linhas, seja revogando outra pessoa ou revogando a si mesmo (auto-
-- revogação é permitida, só não quando é o último). O `SELECT ...
-- FOR UPDATE` sem WHERE trava todas as linhas da tabela antes de
-- contar, para que duas revogações concorrentes não passem ambas
-- pela checagem de "sobra pelo menos um" e zerem a tabela numa
-- corrida — mesma técnica de travar-antes-de-decidir já usada em
-- redeem_invitation (019_invitation_rpcs.sql).
-- ============================================================
CREATE OR REPLACE FUNCTION public.revoke_platform_admin(p_target_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_total_count INTEGER;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'target_user_id is required' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = p_target_user_id) THEN
    RAISE EXCEPTION 'User is not a platform admin' USING ERRCODE = '22023';
  END IF;

  -- Trava todas as linhas antes de contar — Postgres não permite
  -- FOR UPDATE junto de count(*), por isso são duas instruções.
  PERFORM 1 FROM public.platform_admins FOR UPDATE;

  SELECT count(*) INTO v_total_count FROM public.platform_admins;

  IF v_total_count <= 1 THEN
    RAISE EXCEPTION 'Cannot remove the last platform admin' USING ERRCODE = '23505';
  END IF;

  DELETE FROM public.platform_admins WHERE user_id = p_target_user_id;

  INSERT INTO public.platform_audit_log (actor_user_id, action, target_user_id, metadata)
  VALUES (v_caller_id, 'platform_admin.revoke', p_target_user_id, '{}'::jsonb);
END;
$$;

ALTER FUNCTION public.revoke_platform_admin(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.revoke_platform_admin(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_platform_admin(UUID) TO authenticated;
