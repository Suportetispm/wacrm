-- ============================================================
-- 055_fix_account_has_any_data_seed_exclusion
--
-- CORREÇÃO BLOQUEANTE — bug confirmado em produção: a tela Superadmin
-- "Criar usuário" estava deixando para trás uma account fantasma
-- (dona do usuário recém-criado, account_role='owner') em vez de
-- vincular o usuário à empresa selecionada.
--
-- CAUSA RAIZ:
--   1. Toda linha nova em auth.users dispara handle_new_user() (017),
--      que cria uma accounts pessoal temporária + profile owner.
--   2. platform_attach_user_to_account (048) só move esse profile
--      se a conta temporária estiver realmente vazia.
--   3. A migration 052 passou a criar automaticamente os seeds de
--      Chamados Internos para toda account nova.
--   4. account_has_any_data() passou então a considerar a conta
--      temporária como tendo "dados operacionais", impedindo a
--      transferência para a empresa selecionada.
--
-- CORREÇÃO:
-- account_has_any_data() passa a ignorar SOMENTE as 4 tabelas que
-- recebem dados automaticamente por seed:
--
--   - internal_ticket_types
--   - internal_ticket_statuses
--   - internal_ticket_stages
--   - internal_teams
--
-- internal_companies NÃO é ignorada, pois não recebe seed automático.
--
-- Nenhuma outra tabela, trigger, RLS ou função é alterada.
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
        'internal_teams'
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
-- OWNER / SECURITY
-- ============================================================

ALTER FUNCTION public.account_has_any_data(UUID)
OWNER TO postgres;

-- A função é interna e utilizada por outras funções SECURITY DEFINER.
-- Nenhum cliente/API deve executá-la diretamente.

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
-- VALIDAÇÃO MANUAL
-- ============================================================
--
-- 1. Confirmar existência, owner e SECURITY DEFINER:
--
-- SELECT
--   p.proname,
--   r.rolname AS owner,
--   p.prosecdef
-- FROM pg_proc p
-- JOIN pg_roles r
--   ON r.oid = p.proowner
-- WHERE p.pronamespace = 'public'::regnamespace
--   AND p.proname = 'account_has_any_data';
--
-- Esperado:
--   owner     = postgres
--   prosecdef = true
--
--
-- 2. Confirmar ausência de grants para clientes:
--
-- SELECT
--   grantee,
--   privilege_type
-- FROM information_schema.routine_privileges
-- WHERE routine_schema = 'public'
--   AND routine_name = 'account_has_any_data'
-- ORDER BY grantee;
--
-- Não deve existir EXECUTE para:
--   PUBLIC
--   anon
--   authenticated
--   service_role
--
--
-- 3. Conta contendo apenas os seeds automáticos da 052:
--
-- SELECT public.account_has_any_data('<ACCOUNT_ID>');
--
-- Esperado:
--   false
--
--
-- 4. Conta contendo dado operacional real:
--
-- SELECT public.account_has_any_data('<ACCOUNT_ID>');
--
-- Esperado:
--   true
--
--
-- 5. internal_companies continua sendo considerada dado real:
--
-- Se uma account possuir pelo menos uma linha em internal_companies,
-- account_has_any_data(account_id) deve retornar true.
--
--
-- 6. Teste final após atualização da aplicação:
--
-- Antes de criar o usuário:
--
-- SELECT count(*) FROM public.accounts;
--
-- Criar usuário no Superadmin selecionando uma account existente.
--
-- Depois:
--
-- SELECT count(*) FROM public.accounts;
--
-- A quantidade deve permanecer EXATAMENTE igual.
-- ============================================================