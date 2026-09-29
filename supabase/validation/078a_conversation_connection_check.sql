-- ============================================================
-- 078a_conversation_connection_check.sql
--
-- Verificação da migration 078_conversation_connection_tracking.sql.
--
--   SEÇÃO 1 — estrutural + leitura de dados, SEM escrita. Segura em
--             produção.
--   SEÇÃO 2 — comportamental, dados sintéticos, BEGIN/ROLLBACK.
--             SÓ STAGING. NUNCA EXECUTAR EM PRODUÇÃO.
--
-- Rode a Seção 1 sozinha em produção (selecione só até o marcador
-- "FIM DA SEÇÃO 1").
-- ============================================================

-- ============================================================
-- SEÇÃO 1 — PRODUÇÃO / SOMENTE LEITURA
-- ============================================================

-- 1/2. Coluna existe e é nullable
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'conversations'
  AND column_name = 'whatsapp_config_id';
-- Esperado: 1 linha — uuid, is_nullable = YES.

-- 3. FK composta, NO ACTION
SELECT conname, pg_get_constraintdef(oid) AS definition,
       confdeltype AS on_delete, confupdtype AS on_update, convalidated
FROM pg_constraint
WHERE conrelid = 'public.conversations'::regclass
  AND conname = 'conversations_whatsapp_config_account_fkey';
-- Esperado: FOREIGN KEY (whatsapp_config_id, account_id) REFERENCES
-- whatsapp_config(id, account_id); on_delete = 'a', on_update = 'a'
-- (a = NO ACTION); convalidated = true.

-- 4. UNIQUE(id, account_id) em whatsapp_config
SELECT conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.whatsapp_config'::regclass
  AND conname = 'whatsapp_config_id_account_key';
-- Esperado: contype = 'u', UNIQUE (id, account_id).

-- 077 continua valendo: UNIQUE(account_id) segue ausente
SELECT count(*) AS should_be_zero
FROM pg_constraint
WHERE conrelid = 'public.whatsapp_config'::regclass
  AND conname = 'whatsapp_config_account_id_key';
-- Esperado: 0.

-- 5/6/7. Índices: os dois novos + o antigo intacto
SELECT i.relname AS index_name, ix.indisunique, ix.indisvalid,
       pg_get_indexdef(ix.indexrelid) AS definition
FROM pg_index ix
JOIN pg_class i ON i.oid = ix.indexrelid
WHERE ix.indrelid = 'public.conversations'::regclass
  AND i.relname IN (
    'idx_conversations_whatsapp_config',
    'idx_conversations_account_contact_config',
    'idx_conversations_account_contact'
  )
ORDER BY i.relname;
-- Esperado (3 linhas, todas indisvalid = true):
--   idx_conversations_account_contact         unique  (account_id, contact_id)          — SEM WHERE (036, intacto)
--   idx_conversations_account_contact_config  unique  (account_id, contact_id, whatsapp_config_id) WHERE (whatsapp_config_id IS NOT NULL)
--   idx_conversations_whatsapp_config         não-unique (whatsapp_config_id) WHERE (whatsapp_config_id IS NOT NULL)

-- 8. RLS continua ativa
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.conversations'::regclass;
-- Esperado: true.

-- 9. Policies inalteradas
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'conversations'
ORDER BY policyname;
-- Esperado: byte-a-byte igual ao bloco 7 do preflight
-- (conversations_insert, conversations_select, conversations_update;
-- sem conversations_delete).

-- 10. Triggers: mesmo conjunto do preflight
SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgrelid = 'public.conversations'::regclass AND NOT tgisinternal
ORDER BY tgname;
-- Esperado: enforce_privilege_columns, on_conversation_assigned,
-- set_updated_at, validate_queue_tenancy — todos tgenabled = 'O'.

-- 11. whatsapp_config_id protegido pelo trigger
SELECT
  pg_get_functiondef('public.conversations_enforce_privilege_columns()'::regprocedure)
    ILIKE '%NEW.whatsapp_config_id IS DISTINCT FROM OLD.whatsapp_config_id%' AS protects_whatsapp_config_id,
  pg_get_functiondef('public.conversations_enforce_privilege_columns()'::regprocedure)
    ILIKE '%NEW.unread_count IS DISTINCT FROM OLD.unread_count%' AS still_protects_076_columns,
  pg_get_functiondef('public.conversations_enforce_privilege_columns()'::regprocedure)
    ILIKE '%current_user = ''authenticated''%' AS same_discriminator;
-- Esperado: true, true, true.

SELECT p.prosecdef AS security_definer, array_to_string(p.proacl, ', ') AS acl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'conversations_enforce_privilege_columns';
-- Esperado: security_definer = false; ACL sem EXECUTE para
-- PUBLIC/anon/authenticated/service_role (igual ao preflight).

-- 12. Nenhuma conversation aponta para conexão de outra account
SELECT count(*) AS should_be_zero
FROM public.conversations c
JOIN public.whatsapp_config w ON w.id = c.whatsapp_config_id
WHERE w.account_id <> c.account_id;
-- Esperado: 0 (a FK composta torna isto impossível).

-- Nenhum whatsapp_config_id órfão
SELECT count(*) AS should_be_zero
FROM public.conversations c
WHERE c.whatsapp_config_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.whatsapp_config w WHERE w.id = c.whatsapp_config_id);
-- Esperado: 0.

-- 13. Backfill
WITH cfg AS (
  SELECT account_id, count(*) AS configs FROM public.whatsapp_config GROUP BY account_id
)
SELECT
  CASE WHEN cfg.configs = 1 THEN 'account com 1 config'
       WHEN cfg.configs IS NULL THEN 'account sem config'
       ELSE 'account com >1 config' END AS bucket,
  count(*) FILTER (WHERE c.whatsapp_config_id IS NOT NULL) AS filled,
  count(*) FILTER (WHERE c.whatsapp_config_id IS NULL) AS null_rows,
  count(*) AS total
FROM public.conversations c
LEFT JOIN cfg ON cfg.account_id = c.account_id
GROUP BY 1
ORDER BY 1;
-- Esperado LOGO APÓS a migration:
--   'account com 1 config'  → null_rows = 0.
--   'account sem config' / 'account com >1 config' → filled = 0
--     (NULL permitido; nada foi adivinhado).
-- ATENÇÃO: até a 078B, os callers continuam criando conversas SEM
-- whatsapp_config_id. null_rows > 0 no bucket de 1 config, rodado
-- dias depois, = conversas novas desde a migration — não é falha.
-- Reexecutar o bloco 7 (backfill) da migration completa-as
-- (idempotente).

-- Numa account com 1 config, toda conversa preenchida aponta para ELA
WITH single_config AS (
  SELECT account_id, (array_agg(id))[1] AS config_id
  FROM public.whatsapp_config GROUP BY account_id HAVING count(*) = 1
)
SELECT count(*) AS should_be_zero
FROM public.conversations c
JOIN single_config s ON s.account_id = c.account_id
WHERE c.whatsapp_config_id IS NOT NULL
  AND c.whatsapp_config_id <> s.config_id;
-- Esperado: 0.

-- 14. Dados preservados
SELECT count(*) AS total_conversations,
       count(DISTINCT account_id) AS accounts_with_conversations
FROM public.conversations;
-- Esperado: igual ao bloco 9 do preflight (+ conversas criadas pelo
-- tráfego normal no intervalo). A migration não insere nem apaga.

SELECT count(*) AS should_be_zero
FROM (
  SELECT 1 FROM public.conversations
  GROUP BY account_id, contact_id HAVING count(*) > 1
) d;
-- Esperado: 0 — identidade (account_id, contact_id) inalterada.

SELECT count(*) AS total_whatsapp_config FROM public.whatsapp_config;
-- Esperado: igual ao preflight (a migration não toca linhas de
-- whatsapp_config).

-- ============================================================
-- FIM DA SEÇÃO 1
-- ============================================================


-- ============================================================
-- SEÇÃO 2 — STAGING APENAS. NUNCA EXECUTAR EM PRODUÇÃO.
--
-- BEGIN/ROLLBACK, dados sintéticos com marcador '__078a_check__'.
--
-- Fixture respeita o fluxo real de criação de accounts: o trigger
-- on_auth_user_created (handle_new_user, 017) já cria account +
-- profile a partir do auth.users — a Seção 2 da 077 falhou em
-- idx_accounts_one_per_owner justamente por inserir a account à mão.
-- Aqui a account é LIDA depois do INSERT em auth.users; só é criada
-- manualmente se o trigger não a tiver criado (ele engole erros com
-- RAISE WARNING).
-- ============================================================

BEGIN;

DO $outer$
DECLARE
  v_owner_a   UUID := gen_random_uuid();
  v_owner_b   UUID := gen_random_uuid();
  v_account_a UUID;
  v_account_b UUID;
  v_config_a  UUID := gen_random_uuid();
  v_config_b  UUID := gen_random_uuid();
  v_contact_a UUID;
  v_contact_a2 UUID;
  v_conv_a    UUID;
  v_conv_a2   UUID;
  v_value     UUID;
  v_rows      INTEGER;
BEGIN
  RAISE NOTICE '=== 078A validation: building synthetic fixtures ===';

  -- Owner A → account A (via handle_new_user)
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_owner_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__078a_check__owner_a@example.com', 'x', now(), now(), now(), '{}', '{"full_name":"__078a_check__ A"}');

  SELECT id INTO v_account_a FROM public.accounts WHERE owner_user_id = v_owner_a;
  IF v_account_a IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('__078a_check__ A', v_owner_a)
    RETURNING id INTO v_account_a;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_owner_a, '__078a_check__ A', '__078a_check__owner_a@example.com', v_account_a, 'owner');
  END IF;

  -- Owner B → account B
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_owner_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '__078a_check__owner_b@example.com', 'x', now(), now(), now(), '{}', '{"full_name":"__078a_check__ B"}');

  SELECT id INTO v_account_b FROM public.accounts WHERE owner_user_id = v_owner_b;
  IF v_account_b IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('__078a_check__ B', v_owner_b)
    RETURNING id INTO v_account_b;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_owner_b, '__078a_check__ B', '__078a_check__owner_b@example.com', v_account_b, 'owner');
  END IF;

  INSERT INTO public.whatsapp_config (id, account_id, user_id, provider, uazapi_instance_id, status)
  VALUES (v_config_a, v_account_a, v_owner_a, 'uazapi', '__078a_check__inst_a', 'disconnected');
  INSERT INTO public.whatsapp_config (id, account_id, user_id, provider, uazapi_instance_id, status)
  VALUES (v_config_b, v_account_b, v_owner_b, 'uazapi', '__078a_check__inst_b', 'disconnected');

  INSERT INTO public.contacts (account_id, user_id, phone, name)
  VALUES (v_account_a, v_owner_a, '+5500078000001', '__078a_check__ contact 1')
  RETURNING id INTO v_contact_a;
  INSERT INTO public.contacts (account_id, user_id, phone, name)
  VALUES (v_account_a, v_owner_a, '+5500078000002', '__078a_check__ contact 2')
  RETURNING id INTO v_contact_a2;

  -- ------------------------------------------------------------
  -- PASS 1: conversation com conexão da MESMA account → aceita
  -- ------------------------------------------------------------
  INSERT INTO public.conversations (account_id, user_id, contact_id, whatsapp_config_id)
  VALUES (v_account_a, v_owner_a, v_contact_a, v_config_a)
  RETURNING id INTO v_conv_a;
  RAISE NOTICE 'PASS 1: FK composta aceita conexão da mesma account';

  -- ------------------------------------------------------------
  -- PASS 2: legado — conversation sem conexão (NULL) → aceita
  -- ------------------------------------------------------------
  INSERT INTO public.conversations (account_id, user_id, contact_id)
  VALUES (v_account_a, v_owner_a, v_contact_a2)
  RETURNING id INTO v_conv_a2;
  RAISE NOTICE 'PASS 2: whatsapp_config_id NULL continua permitido (callers atuais)';

  -- ------------------------------------------------------------
  -- PASS 3: conexão de OUTRA account → rejeitada (INSERT e UPDATE)
  -- ------------------------------------------------------------
  BEGIN
    UPDATE public.conversations SET whatsapp_config_id = v_config_b WHERE id = v_conv_a2;
    RAISE EXCEPTION 'FAIL 3a: UPDATE para conexão de outra account deveria ter falhado';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS 3a: UPDATE cross-account rejeitado (23503)';
  END;

  DECLARE
    v_contact_b UUID;
  BEGIN
    INSERT INTO public.contacts (account_id, user_id, phone, name)
    VALUES (v_account_b, v_owner_b, '+5500078000003', '__078a_check__ contact B')
    RETURNING id INTO v_contact_b;
    BEGIN
      INSERT INTO public.conversations (account_id, user_id, contact_id, whatsapp_config_id)
      VALUES (v_account_b, v_owner_b, v_contact_b, v_config_a);
      RAISE EXCEPTION 'FAIL 3b: INSERT cross-account deveria ter falhado';
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE NOTICE 'PASS 3b: INSERT cross-account rejeitado (23503)';
    END;
  END;

  -- ------------------------------------------------------------
  -- PASS 4: authenticated NÃO pode alterar whatsapp_config_id
  --         (trigger 076 estendido). Simula a sessão PostgREST do
  --         owner A (admin → passa pela USING de conversations_update).
  -- ------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_owner_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_owner_a::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE public.conversations SET whatsapp_config_id = NULL WHERE id = v_conv_a;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RESET ROLE;
    IF v_rows = 0 THEN
      RAISE EXCEPTION 'FAIL 4: inconclusivo — RLS filtrou a linha (0 rows); a sessão simulada não enxergou a conversation';
    END IF;
    RAISE EXCEPTION 'FAIL 4: authenticated conseguiu alterar whatsapp_config_id';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    -- 42501 também seria o código de um GRANT ausente ou de RLS WITH
    -- CHECK — só conta como PASS se veio do trigger.
    IF SQLERRM NOT ILIKE '%whatsapp_config_id cannot be changed directly%' THEN
      RAISE EXCEPTION 'FAIL 4: 42501 veio de outra origem, não do trigger: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS 4: authenticated bloqueado ao alterar whatsapp_config_id (42501, trigger)';
  END;
  RESET ROLE;

  -- Controle: authenticated ainda consegue alterar uma coluna livre
  -- (status) — o trigger não virou um bloqueio geral.
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET status = 'in_progress' WHERE id = v_conv_a;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RESET ROLE;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL 4b: UPDATE de status por authenticated deveria continuar funcionando (rows=%)', v_rows;
  END IF;
  RAISE NOTICE 'PASS 4b: authenticated continua alterando colunas não protegidas';

  -- ------------------------------------------------------------
  -- PASS 5: postgres/service_role continuam podendo gravar a coluna
  -- ------------------------------------------------------------
  UPDATE public.conversations SET whatsapp_config_id = v_config_a WHERE id = v_conv_a2;
  SELECT whatsapp_config_id INTO v_value FROM public.conversations WHERE id = v_conv_a2;
  IF v_value IS DISTINCT FROM v_config_a THEN
    RAISE EXCEPTION 'FAIL 5: role privilegiada deveria gravar whatsapp_config_id';
  END IF;
  RAISE NOTICE 'PASS 5: role privilegiada grava whatsapp_config_id normalmente';

  -- ------------------------------------------------------------
  -- PASS 6: identidade atual intacta — 2ª conversa do mesmo contato
  --         na mesma account continua proibida (036), mesmo com NULL
  -- ------------------------------------------------------------
  BEGIN
    INSERT INTO public.conversations (account_id, user_id, contact_id)
    VALUES (v_account_a, v_owner_a, v_contact_a);
    RAISE EXCEPTION 'FAIL 6: idx_conversations_account_contact deveria bloquear';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS 6: UNIQUE(account_id, contact_id) segue sendo a identidade vigente';
  END;

  -- ------------------------------------------------------------
  -- PASS 7: backfill (mesmo statement da migration, restrito às
  --         accounts sintéticas para não tocar dado real do staging)
  -- ------------------------------------------------------------
  UPDATE public.conversations SET whatsapp_config_id = NULL WHERE id = v_conv_a2;  -- como postgres
  WITH single_config AS (
    SELECT account_id, (array_agg(id))[1] AS config_id
    FROM public.whatsapp_config
    WHERE account_id IN (v_account_a, v_account_b)
    GROUP BY account_id HAVING count(*) = 1
  )
  UPDATE public.conversations c
  SET whatsapp_config_id = s.config_id
  FROM single_config s
  WHERE c.account_id = s.account_id AND c.whatsapp_config_id IS NULL;
  SELECT whatsapp_config_id INTO v_value FROM public.conversations WHERE id = v_conv_a2;
  IF v_value IS DISTINCT FROM v_config_a THEN
    RAISE EXCEPTION 'FAIL 7a: backfill deveria preencher account com 1 config';
  END IF;
  RAISE NOTICE 'PASS 7a: account com exatamente 1 config é preenchida';

  -- 2ª conexão em A → account deixa de ser determinística
  INSERT INTO public.whatsapp_config (account_id, user_id, provider, uazapi_instance_id, status)
  VALUES (v_account_a, v_owner_a, 'uazapi', '__078a_check__inst_a2', 'disconnected');
  UPDATE public.conversations SET whatsapp_config_id = NULL WHERE id = v_conv_a2;
  WITH single_config AS (
    SELECT account_id, (array_agg(id))[1] AS config_id
    FROM public.whatsapp_config
    WHERE account_id IN (v_account_a, v_account_b)
    GROUP BY account_id HAVING count(*) = 1
  )
  UPDATE public.conversations c
  SET whatsapp_config_id = s.config_id
  FROM single_config s
  WHERE c.account_id = s.account_id AND c.whatsapp_config_id IS NULL;
  SELECT whatsapp_config_id INTO v_value FROM public.conversations WHERE id = v_conv_a2;
  IF v_value IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 7b: backfill NÃO deveria adivinhar conexão em account com >1 config';
  END IF;
  RAISE NOTICE 'PASS 7b: account com >1 config fica NULL (sem adivinhar)';

  -- ------------------------------------------------------------
  -- PASS 8: NO ACTION — hard delete de conexão referenciada é
  --         bloqueado; histórico preservado
  -- ------------------------------------------------------------
  BEGIN
    DELETE FROM public.whatsapp_config WHERE id = v_config_a;
    RAISE EXCEPTION 'FAIL 8: delete de whatsapp_config referenciada deveria falhar';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS 8: delete de conexão referenciada bloqueado (23503) — conversa preservada';
  END;

  -- ------------------------------------------------------------
  -- PASS 9: NO ACTION não quebra o cascade de account
  -- ------------------------------------------------------------
  BEGIN
    DELETE FROM public.accounts WHERE id = v_account_a;
    RAISE NOTICE 'PASS 9: DELETE de account em cascata passa (NO ACTION checado no fim do statement)';
  EXCEPTION
    WHEN foreign_key_violation THEN
      IF SQLERRM ILIKE '%conversations_whatsapp_config_account_fkey%' THEN
        RAISE EXCEPTION 'FAIL 9: a FK nova bloqueou o cascade de account: %', SQLERRM;
      END IF;
      RAISE NOTICE 'SKIP 9: delete de account bloqueado por outra FK não relacionada à 078: %', SQLERRM;
  END;

  RAISE NOTICE '=== 078A validation: TODOS OS TESTES PASSARAM ===';
END;
$outer$;

ROLLBACK;
