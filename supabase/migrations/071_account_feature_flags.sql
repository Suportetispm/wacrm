-- ============================================================
-- 071_account_feature_flags
--
-- ETAPA PILOTO 0 — infraestrutura genérica de feature flags por
-- account, pré-requisito para o piloto controlado de multiconexão/
-- multiunidade (ver WACRM_PILOTO_MULTICONEXAO.md). Esta migration
-- SÓ cria a infraestrutura de flag — nenhuma feature de negócio
-- (multiconexão, business_units) é tocada aqui. NÃO aplicada
-- automaticamente; NÃO é uma migration destrutiva; puramente aditiva.
--
-- AUDITORIA PRÉVIA (resumo — feita antes de escrever esta migration):
--   - accounts hoje: id, name, owner_user_id, created_at, updated_at,
--     default_currency, is_active, disabled_at. Nenhuma coluna JSONB,
--     plan, tier ou feature — confirmado não existir nada reaproveitável
--     ali (ver WACRM_PILOTO_MULTICONEXAO.md, item 1).
--   - profiles.beta_features (011_profile_beta_features.sql) é POR
--     USUÁRIO, não por conta — deliberadamente NÃO reaproveitado aqui
--     (a própria migration 011 já registra que a intenção original era
--     "per-account flag" e não foi isso que saiu).
--   - Padrão copiado: public.platform_admins +
--     public.platform_audit_log + is_platform_admin() (046) +
--     platform_set_account_active (047) — RPC SECURITY DEFINER gated
--     por is_platform_admin(), auto-checagem, auditoria em
--     platform_audit_log, REVOKE amplo + GRANT só para authenticated
--     (a própria RPC re-checa is_platform_admin() por dentro, então
--     "qualquer authenticated pode CHAMAR a RPC" não significa "qualquer
--     authenticated pode USÁ-LA com sucesso").
--   - Tabela "sem nenhuma policy de RLS para authenticated/anon" já
--     tem dois precedentes diretos: platform_admins (046) e
--     user_permission_overrides (062) — mesmo padrão aplicado aqui.
--     Decisão explícita (não é esquecimento): esta etapa não tem
--     nenhum consumidor client-side que precise ler a flag direto do
--     navegador (o helper server-side em
--     src/lib/accounts/feature-flags.ts é quem lê, sempre via
--     service-role). Se um dia a UI precisar saber "minha conta tem X
--     habilitado?" sem um round-trip a uma rota /api/**, isso vira uma
--     migration nova adicionando uma policy de SELECT estreita
--     (`is_account_member(account_id)`), não um ajuste retroativo
--     desta.
--   - allowlist de feature_key: TEXT + CHECK (ARRAY[...]), mesmo
--     padrão de user_permission_overrides.permission_key (062) — não
--     account_role_enum (ENUM), porque o padrão mais recente e mais
--     próximo em espírito (um catálogo pequeno e fechado de "chaves"
--     administrativas, não um papel estrutural do produto inteiro) já
--     é TEXT+CHECK, e ALTER TYPE ... ADD VALUE em enum tem restrições
--     de uso transacional que uma lista fechada e pequena não precisa
--     enfrentar.
--   - id UUID DEFAULT gen_random_uuid() (não uuid_generate_v4()) —
--     segue o padrão mais recente usado em platform_admins/
--     platform_audit_log (046), tabelas irmãs em espírito desta (ambas
--     só tocadas por RPC de platform admin).
--
-- NENHUMA feature fica ativa após esta migration: a tabela nasce
-- vazia, e toda leitura (helper) trata ausência de linha como
-- enabled=false — nenhuma account muda de comportamento observável.
-- ------------------------------------------------------------

-- ============================================================
-- ACCOUNT_FEATURE_FLAGS
--
-- Uma linha por (account, feature) já habilitada ou explicitamente
-- desabilitada. Ausência de linha para um par (account_id,
-- feature_key) = false — nunca é necessário popular uma linha para
-- "desligar" uma feature, só para ligá-la.
--
-- RLS habilitada e SEM NENHUMA policy para authenticated/anon — nega
-- toda leitura/escrita para essas roles por padrão no Postgres,
-- independente de qualquer GRANT de schema. Único caminho de
-- leitura/escrita: service_role (helper server-side) ou a função
-- SECURITY DEFINER platform_set_account_feature abaixo.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.account_feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL CHECK (feature_key = ANY (ARRAY[
    'multi_connection_enabled',
    'business_units_enabled'
  ])),
  enabled BOOLEAN NOT NULL DEFAULT false,
  -- Quem (Superadmin) setou este valor por último — audit mínimo,
  -- nunca usado para autorização. SET NULL (não CASCADE): a saída do
  -- ator do sistema não deve apagar o histórico de qual conta tem a
  -- flag ligada.
  updated_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, feature_key)
);

-- UNIQUE(account_id, feature_key) já cria um índice que cobre "todas
-- as flags de uma conta" (account_id é a coluna líder) — nenhum
-- índice adicional é necessário para este tamanho e padrão de acesso.

ALTER TABLE public.account_feature_flags ENABLE ROW LEVEL SECURITY;

-- Nenhuma policy é criada de propósito — ver comentário acima.

-- Defesa em profundidade além da RLS: mesmo raciocínio de
-- platform_admins (046) e user_permission_overrides (062).
-- service_role não é revogado (bypassa RLS por definição; é o caminho
-- legítimo para o helper server-side e para a RPC abaixo).
REVOKE ALL ON TABLE public.account_feature_flags FROM PUBLIC;
REVOKE ALL ON TABLE public.account_feature_flags FROM anon;
REVOKE ALL ON TABLE public.account_feature_flags FROM authenticated;

DROP TRIGGER IF EXISTS set_updated_at ON public.account_feature_flags;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.account_feature_flags
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- PLATFORM_SET_ACCOUNT_FEATURE(p_account_id, p_feature_key, p_enabled)
--
-- Único caminho para ligar/desligar uma feature flag de uma conta.
-- Mesmo padrão de auto-checagem e auditoria de
-- platform_set_account_active (047): SECURITY DEFINER, exige
-- is_platform_admin() do chamador, UPSERT atômico, grava em
-- platform_audit_log com valor anterior e novo.
--
-- Garante a linha primeiro (INSERT ... ON CONFLICT DO NOTHING com
-- enabled=false como placeholder) e só depois trava e lê o valor
-- anterior com FOR UPDATE — nessa ordem, o FOR UPDATE SEMPRE tem uma
-- linha real para travar, mesmo na primeiríssima chamada para aquele
-- par (account_id, feature_key). Fazer o FOR UPDATE direto (sem
-- garantir a linha antes) deixaria uma corrida real: duas chamadas
-- concorrentes de PRIMEIRA escrita para o mesmo par não teriam nada
-- para travar, ambas leriam "sem linha = false" e o platform_audit_log
-- de uma delas registraria previous_enabled incorreto (o valor final
-- de `enabled` continuaria correto por causa do UPSERT, só a
-- auditoria do valor anterior que ficaria errada). Mesmo espírito de
-- travar-antes-de-decidir já usado em revoke_platform_admin (046) e
-- create_account_member (062), adaptado para o caso em que a própria
-- linha ainda pode não existir.
--
-- Códigos de erro seguem a convenção já usada nas RPCs de plataforma:
--   42501 (insufficient_privilege)  — não autenticado ou sem
--          privilégio de platform admin.
--   22023 (invalid_parameter_value) — entrada inválida (parâmetro
--          nulo, feature_key fora da allowlist, conta inexistente).
-- Mensagens nunca incluem o UUID da conta-alvo.
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

  IF p_feature_key <> ALL (ARRAY['multi_connection_enabled', 'business_units_enabled']) THEN
    RAISE EXCEPTION 'feature_key must be one of: multi_connection_enabled, business_units_enabled'
      USING ERRCODE = '22023';
  END IF;

  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'enabled is required' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = p_account_id) THEN
    RAISE EXCEPTION 'Account not found' USING ERRCODE = '22023';
  END IF;

  -- Garante que a linha existe (placeholder enabled=false na primeira
  -- vez; no-op se já existir) ANTES do FOR UPDATE — ver comentário
  -- acima sobre por que a ordem importa para a corrida de primeira
  -- escrita concorrente.
  INSERT INTO public.account_feature_flags (account_id, feature_key, enabled, updated_by)
  VALUES (p_account_id, p_feature_key, false, v_caller_id)
  ON CONFLICT (account_id, feature_key) DO NOTHING;

  -- Agora a linha garantidamente existe — trava e lê o valor anterior
  -- real (nunca NULL neste ponto).
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
REVOKE ALL ON FUNCTION public.platform_set_account_feature(UUID, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_set_account_feature(UUID, TEXT, BOOLEAN) TO authenticated;

-- ============================================================
-- VALIDAÇÃO MANUAL — ver supabase/validation/
-- 071_account_feature_flags_check.sql (mesmo formato de
-- 069_conversation_active_ticket_visibility_check.sql). NÃO executado
-- automaticamente por esta migration; rodar manualmente contra
-- STAGING depois de aplicar esta migration lá, NUNCA em produção sem
-- antes validar em staging.
-- ============================================================
