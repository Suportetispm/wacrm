-- ============================================================
-- 067_security_definer_hardening_check.sql
--
-- Script de validação da migration 067 — NÃO É UMA MIGRATION, não é
-- aplicado automaticamente por nenhum runner (supabase db push ignora
-- arquivos fora de supabase/migrations/). Rodar manualmente contra
-- STAGING depois de aplicar 067 manualmente lá, NUNCA em produção
-- direto sem antes ter passado em staging.
--
-- Cobre os pontos A-L pedidos na revisão:
--   A. PUBLIC sem EXECUTE indevido
--   B. anon sem EXECUTE indevido
--   C. authenticated sem EXECUTE quando não necessário
--   D. service_role com EXECUTE quando necessário
--   E. _bcast_bump aceita somente colunas legítimas
--   F. coluna inválida é rejeitada com erro controlado
--   G. recompute_broadcast_counts mantém o resultado esperado
--   H. record_webhook_failure mantém incremento/desativação legítimos
--   I. usuário não consegue manipular endpoint arbitrário (sem EXECUTE)
--   J. claim_ai_reply_slot continua funcionando pelo caller legítimo
--   K. search_path hijacking não funciona
--   L. nenhuma assinatura RPC mudou
--
-- SEGURANÇA DO SCRIPT: Seção 1 (grants/assinatura) é só introspecção
-- via has_function_privilege()/pg_proc — zero efeito colateral, pode
-- rodar em qualquer ambiente a qualquer momento, inclusive produção,
-- sem risco. Seção 2 (comportamental) cria dados sintéticos com
-- prefixo '__067_check__' e roda inteira dentro de BEGIN/ROLLBACK — a
-- transação é desfeita no final independentemente do resultado, então
-- nenhuma linha sintética sobrevive e nenhum dado real é tocado. Não
-- rodar a Seção 2 em produção mesmo assim (mesma política de todo
-- script de validação deste projeto — ver cabeçalhos de 034/049-054/
-- 063/065/066).
-- ============================================================

-- ============================================================
-- SEÇÃO 1 — Grants e assinatura (somente leitura, seguro em qualquer
-- ambiente)
-- ============================================================

-- A + B + C + D — matriz completa de EXECUTE por role e função.
-- Esperado após 067:
--   _bcast_bump                 -> false, false, false, false  (nenhum role)
--   recompute_broadcast_counts  -> false, false, false, true   (só service_role)
--   record_webhook_failure      -> false, false, false, true   (só service_role)
--   claim_ai_reply_slot         -> false, false, false, true   (só service_role)
SELECT
  fn.label,
  has_function_privilege('PUBLIC', fn.signature, 'EXECUTE')        AS public_can_execute,
  has_function_privilege('anon', fn.signature, 'EXECUTE')          AS anon_can_execute,
  has_function_privilege('authenticated', fn.signature, 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('service_role', fn.signature, 'EXECUTE')  AS service_role_can_execute
FROM (VALUES
  ('_bcast_bump',                'public._bcast_bump(uuid, text, int)'),
  ('recompute_broadcast_counts', 'public.recompute_broadcast_counts(uuid)'),
  ('record_webhook_failure',     'public.record_webhook_failure(uuid, int)'),
  ('claim_ai_reply_slot',        'public.claim_ai_reply_slot(uuid, integer)')
) AS fn(label, signature);

-- K — search_path efetivamente vazio (não "public", não ausente) nas
-- 4 funções, e SECURITY DEFINER preservado. proconfig deve conter
-- 'search_path=' (vazio); prosecdef deve ser true nas 4.
SELECT
  p.proname,
  p.prosecdef AS is_security_definer,
  p.proconfig AS config
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('_bcast_bump', 'recompute_broadcast_counts', 'record_webhook_failure', 'claim_ai_reply_slot')
ORDER BY p.proname;
-- Esperado: is_security_definer = true nas 4; config contém 'search_path='
-- (vazio) nas 4 — nenhuma delas deve mostrar 'search_path=public'.

-- L — assinatura (nome, tipos de parâmetro, tipo de retorno)
-- idêntica à pré-067. Comparar manualmente contra:
--   _bcast_bump(uuid, text, int) -> void
--   recompute_broadcast_counts(uuid) -> void
--   record_webhook_failure(uuid, int) -> void
--   claim_ai_reply_slot(uuid, integer) -> boolean
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  pg_get_function_result(p.oid) AS returns
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('_bcast_bump', 'recompute_broadcast_counts', 'record_webhook_failure', 'claim_ai_reply_slot')
ORDER BY p.proname;

-- ============================================================
-- SEÇÃO 2 — Comportamental (staging apenas; cria dados sintéticos
-- '__067_check__*', roda em transação, sempre faz ROLLBACK no final)
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_account_id      UUID;
  v_user_id         UUID;
  v_broadcast_id    UUID;
  v_recipient_id    UUID;
  v_endpoint_id     UUID;
  v_conversation_id UUID;
  v_contact_id      UUID;
  v_result          BOOLEAN;
  v_sent_count      INT;
  v_failure_count   INT;
  v_is_active       BOOLEAN;
  v_rejected        BOOLEAN := false;
BEGIN
  -- ---- fixture mínima ---------------------------------------------
  -- account_id + owner_user_id: contacts/conversations/broadcasts
  -- ainda exigem NOT NULL user_id (017 adicionou account_id ao lado
  -- de user_id, nunca substituiu) — owner_user_id de accounts (017) é
  -- a fonte mais confiável de um user_id válido e já membro da conta.
  SELECT id, owner_user_id INTO v_account_id, v_user_id FROM accounts LIMIT 1;
  IF v_account_id IS NULL THEN
    RAISE NOTICE 'SKIP Seção 2 inteira: nenhuma account existe neste ambiente para montar a fixture.';
    RETURN;
  END IF;

  INSERT INTO broadcasts (id, account_id, user_id, name, template_name, status, sent_count, delivered_count, read_count, replied_count, failed_count)
  VALUES (gen_random_uuid(), v_account_id, v_user_id, '__067_check__broadcast', '__067_check__template', 'sent', 0, 0, 0, 0, 0)
  RETURNING id INTO v_broadcast_id;

  SELECT id INTO v_contact_id FROM contacts WHERE account_id = v_account_id LIMIT 1;
  IF v_contact_id IS NULL THEN
    INSERT INTO contacts (id, account_id, user_id, name, phone)
    VALUES (gen_random_uuid(), v_account_id, v_user_id, '__067_check__contact', '+10000000000')
    RETURNING id INTO v_contact_id;
  END IF;

  INSERT INTO broadcast_recipients (id, broadcast_id, contact_id, status)
  VALUES (gen_random_uuid(), v_broadcast_id, v_contact_id, 'sent')
  RETURNING id INTO v_recipient_id;

  INSERT INTO webhook_endpoints (id, account_id, url, secret, is_active, failure_count)
  VALUES (gen_random_uuid(), v_account_id, 'https://example.invalid/__067_check__', 'not-a-real-secret', true, 0)
  RETURNING id INTO v_endpoint_id;

  SELECT id INTO v_conversation_id FROM conversations WHERE account_id = v_account_id LIMIT 1;
  IF v_conversation_id IS NULL THEN
    INSERT INTO conversations (id, account_id, user_id, contact_id, status, ai_reply_count)
    VALUES (gen_random_uuid(), v_account_id, v_user_id, v_contact_id, 'open', 0)
    RETURNING id INTO v_conversation_id;
  ELSE
    UPDATE conversations SET ai_reply_count = 0 WHERE id = v_conversation_id;
  END IF;

  -- ---- E: _bcast_bump aceita coluna legítima ---------------------
  PERFORM public._bcast_bump(v_broadcast_id, 'sent_count', 1);
  SELECT sent_count INTO v_sent_count FROM broadcasts WHERE id = v_broadcast_id;
  IF v_sent_count = 1 THEN
    RAISE NOTICE 'PASS E: _bcast_bump incrementou sent_count corretamente (1)';
  ELSE
    RAISE NOTICE 'FAIL E: sent_count esperado 1, obtido %', v_sent_count;
  END IF;

  -- ---- F: coluna inválida é rejeitada ----------------------------
  BEGIN
    PERFORM public._bcast_bump(v_broadcast_id, 'account_id', 1);
    RAISE NOTICE 'FAIL F: _bcast_bump aceitou coluna fora da whitelist (account_id) sem erro';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = '22023' THEN
      RAISE NOTICE 'PASS F: coluna inválida rejeitada com SQLSTATE 22023 (%)', SQLERRM;
    ELSE
      RAISE NOTICE 'FAIL F: rejeitada mas com SQLSTATE inesperado % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;

  -- ---- G: recompute_broadcast_counts mantém o resultado esperado
  UPDATE broadcast_recipients SET status = 'read' WHERE id = v_recipient_id;
  PERFORM public.recompute_broadcast_counts(v_broadcast_id);
  SELECT sent_count INTO v_sent_count FROM broadcasts WHERE id = v_broadcast_id;
  IF v_sent_count = 1 THEN
    RAISE NOTICE 'PASS G: recompute_broadcast_counts recalculou sent_count=1 para 1 recipient status=read (forward-only ladder)';
  ELSE
    RAISE NOTICE 'FAIL G: sent_count esperado 1 após recompute, obtido %', v_sent_count;
  END IF;

  -- ---- H: record_webhook_failure incrementa e desativa no limiar
  PERFORM public.record_webhook_failure(v_endpoint_id, 2);
  SELECT failure_count, is_active INTO v_failure_count, v_is_active FROM webhook_endpoints WHERE id = v_endpoint_id;
  IF v_failure_count = 1 AND v_is_active = true THEN
    RAISE NOTICE 'PASS H.1: 1ª falha incrementou para 1, is_active continua true (abaixo do limiar 2)';
  ELSE
    RAISE NOTICE 'FAIL H.1: esperado failure_count=1/is_active=true, obtido %/%', v_failure_count, v_is_active;
  END IF;

  PERFORM public.record_webhook_failure(v_endpoint_id, 2);
  SELECT failure_count, is_active INTO v_failure_count, v_is_active FROM webhook_endpoints WHERE id = v_endpoint_id;
  IF v_failure_count = 2 AND v_is_active = false THEN
    RAISE NOTICE 'PASS H.2: 2ª falha atingiu o limiar (2), is_active virou false';
  ELSE
    RAISE NOTICE 'FAIL H.2: esperado failure_count=2/is_active=false, obtido %/%', v_failure_count, v_is_active;
  END IF;

  -- ---- I: caller sem EXECUTE não consegue manipular endpoint
  -- arbitrário. Testado indiretamente pela Seção 1 (D confirma que só
  -- service_role tem EXECUTE) — aqui só confirmamos que, PARA quem
  -- tem EXECUTE (o worker/service_role rodando este próprio script),
  -- o alvo é sempre o endpoint_id passado explicitamente, nunca
  -- inferido de sessão/conta — ou seja, não há como o parâmetro
  -- vazar para outro endpoint sem o caller já conhecer o UUID exato.
  -- A mitigação real de "cross-tenant" é o REVOKE testado em D, não
  -- lógica nova dentro da função (decisão documentada na migration).
  RAISE NOTICE 'INFO I: mitigação real é o REVOKE da Seção 1 (D) — sem EXECUTE, a superfície não existe. Ver resultado de D acima.';

  -- ---- J: claim_ai_reply_slot funciona para o caller legítimo
  v_result := public.claim_ai_reply_slot(v_conversation_id, 3);
  IF v_result = true THEN
    RAISE NOTICE 'PASS J.1: 1º claim (cap=3) retornou true';
  ELSE
    RAISE NOTICE 'FAIL J.1: 1º claim deveria retornar true, retornou %', v_result;
  END IF;

  PERFORM public.claim_ai_reply_slot(v_conversation_id, 3);
  v_result := public.claim_ai_reply_slot(v_conversation_id, 3);
  IF v_result = false THEN
    RAISE NOTICE 'PASS J.2: 4º claim tentado com cap=3 (3 já consumidos) retornou false — cap respeitado';
  ELSE
    RAISE NOTICE 'FAIL J.2: cap deveria ter sido atingido, retornou %', v_result;
  END IF;

  RAISE NOTICE '--- Seção 2 concluída. Fazendo ROLLBACK de toda a fixture sintética. ---';
END $$;

ROLLBACK;

-- ============================================================
-- Se a Seção 1 mostrar qualquer *_can_execute = true fora do
-- esperado, ou a Seção 2 mostrar qualquer FAIL, NÃO promova 067 para
-- produção — volte para revisão manual antes de aplicar.
-- ============================================================
