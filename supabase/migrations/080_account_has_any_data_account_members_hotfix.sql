-- ============================================================
-- 080_account_has_any_data_account_members_hotfix
--
-- HOTFIX — regressão introduzida pela 079_account_members (MU-1).
--
-- CAUSA RAIZ (mesmo padrão do bug corrigido pela 055):
--   1. Toda linha nova em auth.users dispara handle_new_user() (017),
--      que cria uma accounts pessoal temporária + profile owner.
--   2. A 079 adicionou o trigger sync_account_members em profiles:
--      esse INSERT de profile cria também a linha
--      (user_id, account temporária) em public.account_members.
--   3. account_has_any_data() varre TODA tabela public com coluna
--      account_id (exceto profiles e os 4 seeds da 052). A 079 criou
--      account_members com account_id — ela entrou na varredura.
--   4. Resultado: a account temporária de TODO usuário recém-criado
--      passa a ter "dado operacional", e
--        create_account_member            (056/062)
--        platform_attach_user_to_account  (048)
--        platform_create_account          (047, caminho de conversão)
--      recusam com 23505 "... already has operational data".
--
-- CORREÇÃO:
--   account_has_any_data() passa a ignorar também account_members —
--   metadado de vínculo usuário ↔ account, equivalente a profiles
--   (que já é ignorada desde a 047), não dado operacional.
--
--   Corpo, assinatura, retorno, volatility (STABLE), SECURITY DEFINER,
--   search_path, owner e revokes IDÊNTICOS à 055. A ÚNICA mudança é
--   'account_members' na lista NOT IN. Todas as demais tabelas com
--   account_id (contacts, conversations, whatsapp_config, deals,
--   internal_companies, queue_members, ...) continuam contando.
--
-- NÃO FAZ: não altera account_members, sync_account_members,
-- profiles, accounts, RLS/policies, nem nenhuma das RPCs chamadoras.
--
-- Pré-requisito: supabase/validation/080_account_has_any_data_hotfix_preflight.sql.
-- Validação:     supabase/validation/080_account_has_any_data_hotfix_check.sql.
-- Idempotente — safe to run multiple times.
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
      ON t.table_schema = c.table_schema
     AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'account_id'
      AND t.table_type = 'BASE TABLE'

      -- profiles não representa dado operacional da account para
      -- finalidade desta validação.
      AND c.table_name <> 'profiles'

      -- HARDENING 055:
      -- estas tabelas são preenchidas automaticamente pelo trigger
      -- seed_internal_ticket_defaults da migration 052.
      -- Sua existência, isoladamente, não significa que a account
      -- possui atividade operacional real.
      AND c.table_name NOT IN (
        'internal_ticket_types',
        'internal_ticket_statuses',
        'internal_ticket_stages',
        'internal_teams',

        -- HOTFIX 080:
        -- vínculo usuário ↔ account (079), preenchido automaticamente
        -- pelo trigger sync_account_members no signup. Mesmo papel de
        -- profiles acima — não é dado operacional.
        'account_members'
      )
  LOOP
    EXECUTE format(
      'SELECT EXISTS (
         SELECT 1
         FROM public.%I
         WHERE account_id = $1
       )',
      v_table.table_name
    )
    INTO v_found
    USING p_account_id;

    IF v_found THEN
      RETURN TRUE;
    END IF;
  END LOOP;

  RETURN FALSE;
END;
$$;

-- ============================================================
-- OWNER / SECURITY — idêntico à 055
-- (CREATE OR REPLACE já preserva owner e ACL; reaplicado por
-- defesa em profundidade, mesmo conjunto de roles.)
-- ============================================================

ALTER FUNCTION public.account_has_any_data(UUID)
OWNER TO postgres;

REVOKE ALL
ON FUNCTION public.account_has_any_data(UUID)
FROM PUBLIC;

REVOKE ALL
ON FUNCTION public.account_has_any_data(UUID)
FROM anon;

REVOKE ALL
ON FUNCTION public.account_has_any_data(UUID)
FROM authenticated;

REVOKE ALL
ON FUNCTION public.account_has_any_data(UUID)
FROM service_role;

-- ============================================================
-- VALIDAÇÃO MANUAL — ver
-- supabase/validation/080_account_has_any_data_hotfix_check.sql.
-- NÃO executado automaticamente por esta migration.
-- ============================================================
