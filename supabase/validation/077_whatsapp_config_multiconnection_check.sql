  -- ============================================================
  -- 077_whatsapp_config_multiconnection_check.sql
  --
  -- Verificação da migration 077. Seção 1 é estrutural (introspecção +
  -- leitura de dados, sem escrita) — segura em produção. Seção 2 é
  -- comportamental (dados sintéticos, BEGIN/ROLLBACK) — mesma política
  -- de todo script deste projeto: só rodar em staging, NUNCA em
  -- produção.
  -- ============================================================

  -- ============================================================
  -- SEÇÃO 1 — estrutural (segura em produção)
  -- ============================================================

  -- whatsapp_config_account_id_key NÃO deve mais existir
  SELECT count(*) AS should_be_zero
  FROM pg_constraint
  WHERE conrelid = 'public.whatsapp_config'::regclass
    AND conname = 'whatsapp_config_account_id_key';
  -- Esperado: 0.

  -- Nenhuma OUTRA UNIQUE apenas em account_id (confirma que nada
  -- recriou uma variante da constraint removida, com outro nome)
  SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
  WHERE conrelid = 'public.whatsapp_config'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) ILIKE '%account_id%'
    AND pg_get_constraintdef(oid) NOT ILIKE '%,%';
  -- Esperado: 0 linhas.

  -- Todas as constraints restantes, para revisão completa lado a lado
  -- com o preflight (PK, UNIQUE phone_number_id, CHECK status, FKs —
  -- todas devem seguir presentes, só a UNIQUE(account_id) sai da lista)
  SELECT conname, contype,
    CASE contype
      WHEN 'p' THEN 'PRIMARY KEY' WHEN 'u' THEN 'UNIQUE'
      WHEN 'c' THEN 'CHECK' WHEN 'f' THEN 'FOREIGN KEY' ELSE contype::text
    END AS type_label,
    pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
  WHERE conrelid = 'public.whatsapp_config'::regclass
  ORDER BY contype, conname;
  -- Esperado: whatsapp_config_pkey, whatsapp_config_phone_number_id_key,
  -- whatsapp_config_status_check, FKs de user_id/account_id/
  -- default_queue_id — tudo igual ao preflight, MENOS
  -- whatsapp_config_account_id_key.

  -- idx_whatsapp_config_account continua existindo como índice normal
  -- (nunca dependeu da UNIQUE removida — 017 já criava os dois
  -- separadamente)
  SELECT indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'whatsapp_config'
  ORDER BY indexname;
  -- Esperado: idx_whatsapp_config_account presente, junto com
  -- idx_whatsapp_config_registered_at, idx_whatsapp_config_default_queue
  -- e os índices implícitos de PK + UNIQUE(phone_number_id) — mesma
  -- lista do preflight, menos o índice implícito da UNIQUE(account_id)
  -- removida.

  -- RLS continua habilitada, policies inalteradas
  SELECT relrowsecurity FROM pg_class WHERE oid = 'public.whatsapp_config'::regclass;
  -- Esperado: true (inalterado).

  SELECT policyname, cmd, qual, with_check
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'whatsapp_config'
  ORDER BY policyname;
  -- Esperado: byte-a-byte igual ao preflight — nenhuma policy tocada.

  -- Triggers inalterados
  SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
  FROM pg_trigger
  WHERE tgrelid = 'public.whatsapp_config'::regclass AND NOT tgisinternal
  ORDER BY tgname;
  -- Esperado: set_updated_at + validate_default_queue_account, igual ao
  -- preflight.

  -- Dados existentes preservados (contagem total + amostra de colunas
  -- sensíveis a comparar manualmente contra o preflight, sem alterar
  -- nada)
  SELECT count(*) AS total_rows FROM public.whatsapp_config;

  SELECT provider, count(*) AS total, count(DISTINCT account_id) AS distinct_accounts
  FROM public.whatsapp_config
  GROUP BY provider;
  -- Esperado: idêntico à distribuição por provider do preflight — a
  -- migration não insere, atualiza nem apaga nenhuma linha.

  -- Duplicidade de uazapi_instance_id — apenas REPORTADA, nenhuma ação
  -- esperada nesta migration (não recebeu UNIQUE; ver cabeçalho da
  -- migration 077 e riscos residuais do relatório da sessão)
  SELECT uazapi_instance_id, count(*) AS c
  FROM public.whatsapp_config
  WHERE uazapi_instance_id IS NOT NULL
  GROUP BY uazapi_instance_id
  HAVING count(*) > 1;
  -- Informativo apenas — não é critério de PASS/FAIL desta migration.

  -- ============================================================
  -- SEÇÃO 2 — comportamental (SÓ STAGING, BEGIN/ROLLBACK — NUNCA
  -- PRODUÇÃO)
  --
  -- Confirma o objetivo direto da 077: duas whatsapp_config na MESMA
  -- account, MESMO provider, coexistindo sem erro.
  -- ============================================================

  BEGIN;

  DO $outer$
  DECLARE
    v_account_id  UUID := gen_random_uuid();
    v_owner_id    UUID := gen_random_uuid();
    v_config_1_id UUID := gen_random_uuid();
    v_config_2_id UUID := gen_random_uuid();
    v_row_count   INT;
  BEGIN
    RAISE NOTICE '=== 077 validation: building synthetic fixtures ===';

    INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
    VALUES (v_owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__077_check__owner@example.com', 'x', now(), now(), now(), '{}', '{}');

    INSERT INTO public.accounts (id, name, owner_user_id, is_active)
    VALUES (v_account_id, '__077_check__ Account', v_owner_id, true);

    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, is_active)
    VALUES (v_owner_id, '__077_check__ Owner', '__077_check__owner@example.com', v_account_id, 'owner', true);

    -- Primeira conexão UAZAPI da account
    INSERT INTO public.whatsapp_config (id, account_id, user_id, provider, uazapi_instance_id, status)
    VALUES (v_config_1_id, v_account_id, v_owner_id, 'uazapi', '__077_check__instance_1', 'disconnected');

    RAISE NOTICE 'PASS 1: primeira whatsapp_config inserida normalmente';

    -- ============================================================
    -- Segunda conexão UAZAPI da MESMA account, MESMO provider — este é
    -- o comportamento que a UNIQUE(account_id) bloqueava antes da 077.
    -- Deve funcionar sem erro depois do DROP CONSTRAINT.
    -- ============================================================
    INSERT INTO public.whatsapp_config (id, account_id, user_id, provider, uazapi_instance_id, status)
    VALUES (v_config_2_id, v_account_id, v_owner_id, 'uazapi', '__077_check__instance_2', 'disconnected');

    RAISE NOTICE 'PASS 2: segunda whatsapp_config na MESMA account/provider inserida sem erro';

    -- Confirma que AMBAS coexistem (ids distintos, mesma account)
    SELECT count(*) INTO v_row_count
    FROM public.whatsapp_config
    WHERE account_id = v_account_id;

    IF v_row_count <> 2 THEN
      RAISE EXCEPTION 'FAIL 3: esperava 2 linhas coexistindo para a mesma account, encontrou %', v_row_count;
    END IF;
    RAISE NOTICE 'PASS 3: as duas linhas coexistem (% linhas para a mesma account)', v_row_count;

    -- phone_number_id continua com UNIQUE — duas linhas com o MESMO
    -- phone_number_id (não-nulo) ainda devem falhar. Confirma que a 077
    -- não afetou nenhuma outra constraint da tabela.
    BEGIN
      UPDATE public.whatsapp_config SET phone_number_id = '__077_check__dup_phone' WHERE id = v_config_1_id;
      UPDATE public.whatsapp_config SET phone_number_id = '__077_check__dup_phone' WHERE id = v_config_2_id;
      RAISE EXCEPTION 'FAIL 4: duas linhas com o MESMO phone_number_id não deveriam coexistir — UNIQUE(phone_number_id) deveria ter bloqueado';
    EXCEPTION
      WHEN unique_violation THEN
        RAISE NOTICE 'PASS 4: UNIQUE(phone_number_id) continua ativa e bloqueando duplicidade — não afetada pela 077';
    END;

    RAISE NOTICE '=== 077 validation: TODOS OS TESTES 1-4 PASSARAM ===';
  END;
  $outer$;

  ROLLBACK;
