-- ============================================================
-- 079_account_members  (ETAPA MU-1)
--
-- Cria public.account_members — o vínculo usuário ↔ account — e faz o
-- backfill 1:1 a partir de profiles. 100% backward-compatible: NADA no
-- runtime passa a ler esta tabela ainda.
--
-- CONTEXTO
--   Hoje a membership É a linha única de profiles (user_id UNIQUE,
--   account_id NOT NULL, account_role, is_active). Um mesmo login não
--   consegue pertencer a duas empresas. A sequência MU leva a:
--     profiles        = identidade global do usuário (1:1 com auth.users)
--     account_members = vínculos com empresas (N por usuário)
--   Esta migration só prepara a estrutura.
--
-- O QUE FAZ
--   1. Tabela account_members (PK id; UNIQUE(user_id, account_id) com nome
--      explícito — alvo das FKs compostas que a MU-2 vai reapontar).
--   2. Índice em account_id (listar membros de uma account). user_id já é
--      coberto pela UNIQUE (user_id, account_id) — coluna líder.
--   3. RLS habilitada. Só leitura:
--        - o próprio usuário lê as próprias memberships;
--        - admin/owner da account lê as memberships da account (estritamente
--          MENOS que profiles_select hoje, que deixa qualquer membro, até
--          viewer, ver profile e papel de todos da account).
--      NENHUMA policy de escrita. Grants de INSERT/UPDATE/DELETE revogados
--      de anon/authenticated: authenticated não cria, não altera papel e não
--      remove membership por nenhum caminho. Escrita só por postgres
--      (migration, trigger abaixo, RPCs SECURITY DEFINER futuras) e
--      service_role.
--   4. updated_at via update_updated_at_column() (001) — reutilizado.
--   5. Trigger TEMPORÁRIO de coerência profiles → account_members (ver
--      abaixo).
--   6. Backfill: uma membership por profile (estado real do MU-0: 21).
--
-- NÃO FAZ (fica para as próximas fases)
--   - não reaponta queue_members / internal_team_members /
--     user_permission_overrides (MU-2);
--   - não toca deals.assigned_to → profiles.id (identidade global — fica
--     assim em todas as fases);
--   - não altera profiles, is_account_member, nenhuma das 130 policies
--     existentes, nenhuma RPC existente, getCurrentAccount, requireRole,
--     useAuth, convites, cadastro de usuário;
--   - não remove idx_accounts_one_per_owner;
--   - não cria business_units.
--
-- COERÊNCIA TEMPORÁRIA (profiles → account_members, unidirecional)
--   Enquanto profiles for o runtime oficial, account_members não pode ficar
--   desatualizada — senão a MU-2 reapontaria FKs para dados velhos e a MU-3
--   leria papéis errados. Caminhos que hoje mudam
--   profiles.account_id/account_role/is_active (authenticated não consegue:
--   enforce_profile_privilege_columns, 034/048):
--     handle_new_user            INSERT profile (signup)
--     platform_create_account    INSERT profile
--     create_account_member      UPDATE account_id/role/is_active (move)
--     platform_attach_user_to_account  UPDATE (move)
--     redeem_invitation          UPDATE account_id/role (move) + DELETE account antiga
--     remove_account_member      UPDATE para account pessoal nova
--     set_member_role            UPDATE account_role
--     transfer_account_ownership UPDATE account_role (x2)
--     platform_update_user       UPDATE role/is_active
--     + DELETE de profile por cascade (auth.users / accounts)
--   Decisão: trigger AFTER em profiles (opção B), e não alterar as 9 RPCs
--   (opção C): um ponto só, cobre também qualquer caminho não mapeado, não
--   reescreve RPCs já em produção (algumas com estado de aplicação não
--   confirmado, ex. 070), e sai com um DROP TRIGGER. Unidirecional: nada
--   em account_members escreve de volta em profiles — uma fonte de verdade
--   só (profiles) durante a MU-1/MU-2.
--   Semântica (mundo 1:1 atual): o conjunto de memberships do usuário É
--   {(user_id, profiles.account_id)}. Mover o profile de account apaga a
--   membership antiga e cria a nova — exatamente o que o runtime faz hoje.
--
--   ⚠️ PRÉ-REQUISITO DA MU-3: este trigger TEM de ser removido/substituído
--   antes de existir a segunda membership de qualquer usuário e antes da
--   "troca de account ativa" — no modelo de ponteiro, trocar
--   profiles.account_id NÃO pode apagar a membership anterior.
--
-- Pré-requisito: supabase/validation/mu1_account_members_preflight.sql.
-- Validação:     supabase/validation/mu1_account_members_check.sql.
-- Idempotente — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1) Tabela
-- ============================================================
CREATE TABLE IF NOT EXISTS public.account_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  role        public.account_role_enum NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  -- Quem convidou/criou. SET NULL: a membership (e o histórico de que ela
  -- existe) sobrevive à remoção de quem convidou.
  invited_by  UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Alvo das FKs compostas (user_id, account_id) da MU-2. Uma só ordem de
  -- colunas: (account_id, user_id) seria redundante — listagem por account
  -- usa o índice simples abaixo.
  CONSTRAINT account_members_user_id_account_id_key UNIQUE (user_id, account_id)
);

COMMENT ON TABLE public.account_members IS
  'Vínculo usuário ↔ account (MU-1). Ainda NÃO é fonte de autorização: o runtime lê profiles. Mantida em sincronia por trigger profiles → account_members até a MU-3.';

-- ============================================================
-- 2) Índices
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_account_members_account
  ON public.account_members (account_id);

-- ============================================================
-- 3) RLS + grants
-- ============================================================
ALTER TABLE public.account_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_members_select_own ON public.account_members;
CREATE POLICY account_members_select_own ON public.account_members
  FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS account_members_select_account_admin ON public.account_members;
CREATE POLICY account_members_select_account_admin ON public.account_members
  FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- Sem policy de INSERT/UPDATE/DELETE: RLS nega por ausência. Revoga também
-- os grants default do Supabase (defesa em profundidade — um GRANT sem
-- policy ainda seria negado pela RLS, mas não deixamos o privilégio lá).
REVOKE ALL ON public.account_members FROM PUBLIC;
REVOKE ALL ON public.account_members FROM anon;
REVOKE ALL ON public.account_members FROM authenticated;
GRANT SELECT ON public.account_members TO authenticated;

-- ============================================================
-- 4) updated_at — helper existente (001)
-- ============================================================
DROP TRIGGER IF EXISTS set_updated_at ON public.account_members;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.account_members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 5) Coerência temporária profiles → account_members
--    SECURITY DEFINER: grava em account_members (sem policy de escrita)
--    independente de quem disparou o UPDATE em profiles. Nunca falha por
--    dado do usuário: só usa colunas NOT NULL de profiles e FKs que o
--    próprio profile já satisfaz. Importante porque handle_new_user tem
--    EXCEPTION WHEN OTHERS — um erro aqui faria o signup ficar sem profile.
-- ============================================================
CREATE OR REPLACE FUNCTION public.account_members_sync_from_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.account_members
    WHERE user_id = OLD.user_id AND account_id = OLD.account_id;
    RETURN OLD;
  END IF;

  -- Profile mudou de account (move 1:1 de hoje): a membership antiga deixa
  -- de existir, igual ao runtime atual.
  IF TG_OP = 'UPDATE'
     AND (NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.account_id IS DISTINCT FROM OLD.account_id)
  THEN
    DELETE FROM public.account_members
    WHERE user_id = OLD.user_id AND account_id = OLD.account_id;
  END IF;

  INSERT INTO public.account_members (user_id, account_id, role, is_active)
  VALUES (NEW.user_id, NEW.account_id, NEW.account_role, NEW.is_active)
  ON CONFLICT (user_id, account_id) DO UPDATE
    SET role = EXCLUDED.role,
        is_active = EXCLUDED.is_active
    WHERE public.account_members.role IS DISTINCT FROM EXCLUDED.role
       OR public.account_members.is_active IS DISTINCT FROM EXCLUDED.is_active;

  RETURN NEW;
END;
$$;

-- Função de trigger: nenhuma role precisa de EXECUTE (mesmo padrão 058/076).
REVOKE EXECUTE ON FUNCTION public.account_members_sync_from_profile() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.account_members_sync_from_profile() FROM anon;
REVOKE EXECUTE ON FUNCTION public.account_members_sync_from_profile() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.account_members_sync_from_profile() FROM service_role;

DROP TRIGGER IF EXISTS sync_account_members ON public.profiles;
CREATE TRIGGER sync_account_members
  AFTER INSERT OR DELETE OR UPDATE OF user_id, account_id, account_role, is_active
  ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.account_members_sync_from_profile();

-- ============================================================
-- 6) Backfill — uma membership por profile (idempotente)
--    Depois do trigger: qualquer profile alterado durante a migration já é
--    refletido pelo trigger; o INSERT abaixo não sobrescreve nada
--    (DO NOTHING) e não toca profiles/accounts.
-- ============================================================
INSERT INTO public.account_members (user_id, account_id, role, is_active)
SELECT user_id, account_id, account_role, is_active
FROM public.profiles
ON CONFLICT (user_id, account_id) DO NOTHING;

-- ============================================================
-- VALIDAÇÃO MANUAL — ver
-- supabase/validation/mu1_account_members_check.sql.
-- NÃO executado automaticamente por esta migration.
-- ============================================================
