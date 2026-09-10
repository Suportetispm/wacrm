-- ============================================================
-- 067_security_definer_hardening
--
-- Hardening pontual de 4 funções SECURITY DEFINER identificadas numa
-- auditoria de segurança (achados #1-#4 da varredura de SECURITY
-- DEFINER). Nenhuma delas teve GRANT/REVOKE explícito quando foi
-- criada — herdam o privilégio padrão do Postgres (EXECUTE para
-- PUBLIC, que inclui `anon`/`authenticated` via PostgREST), apesar de
-- nenhuma ter um caller legítimo fora de `service_role` (ou, no caso
-- de _bcast_bump/recompute_broadcast_counts, nenhum caller externo
-- algum — só triggers internos).
--
-- ESCOPO DESTA MIGRATION (estritamente):
--   1. REVOKE do EXECUTE indevido (PUBLIC/anon/authenticated) nas 4
--      funções, preservando GRANT a service_role só onde já existia
--      caller real usando esse role.
--   2. SET search_path = '' (mais defensivo que o `SET search_path =
--      public` original) + qualificação explícita `public.` em toda
--      tabela referenciada — mesmo padrão já usado em 052/065/066.
--   3. Whitelist explícita das 5 colunas válidas em _bcast_bump, em
--      vez de confiar só no identifier-escaping de format('%I', col).
--
-- NÃO MUDA: assinatura, tipo de retorno, linguagem, algoritmo/fórmula
-- dos contadores, SECURITY DEFINER (permanece necessário nas 4 — cada
-- uma precisa escrever numa tabela que RLS não deixaria o caller real
-- tocar diretamente), triggers existentes, nem nenhuma tabela/coluna.
-- CREATE OR REPLACE sobre a assinatura idêntica da migration original
-- — nenhum DROP FUNCTION, nenhuma mudança de caller compilado/gerado
-- no lado da aplicação.
--
-- CALLERS REAIS confirmados por leitura direta do código-fonte antes
-- desta migration (não presumidos):
--   - _bcast_bump: SEM caller externo. Só chamada internamente por
--     broadcast_recipient_aggregate_trigger() (também SECURITY
--     DEFINER, mesmo dono), disparada pelo trigger
--     broadcast_recipients_aggregate. Uma função SECURITY DEFINER que
--     chama outra herda o contexto de privilégio do OWNER da função
--     chamadora (tipicamente postgres, que sempre pode executar
--     qualquer função) — a cadeia de trigger continua funcionando
--     mesmo com EXECUTE revogado de todo mundo, incluindo
--     service_role. Nenhum `db.rpc('_bcast_bump', ...)` existe em
--     src/ (grep confirmado).
--   - recompute_broadcast_counts: mesma situação — nenhum
--     `db.rpc('recompute_broadcast_counts', ...)` em src/. O
--     comentário original (005, linha 28-30) a mantém como "safety
--     net" para ops rodar manualmente. GRANT a service_role preservado
--     para não fechar esse uso administrativo (idêntico ao padrão já
--     usado em increment_automation_execution_count/007 e
--     increment_flow_execution_count/012 para o mesmo tipo de função
--     "contador interno, sem caller de app, mas com uso operacional
--     ocasional").
--   - record_webhook_failure: único caller real é
--     src/lib/webhooks/deliver.ts:151 (`recordFailure`), chamada a
--     partir de src/app/api/whatsapp/webhook/route.ts (webhook
--     inbound do Meta/UAZAPI) sempre com `db = supabaseAdmin()`
--     (service_role) — confirmado nas 3 chamadas de
--     dispatchWebhookEvent em route.ts (linhas 445/619/859), todas
--     com supabaseAdmin(). Esse caminho não tem `auth.uid()` (é um
--     webhook externo verificado por HMAC, não uma sessão Supabase
--     Auth) — não introduzimos checagem de auth.uid() aqui, seria
--     sempre NULL e quebraria o worker. service_role já bypassa RLS
--     em toda tabela diretamente, então uma checagem de tenancy
--     adicional dentro da função seria decorativa: o objetivo real é
--     impedir que um cliente/usuário chame a função direto, não
--     validar tenancy de um caller que já é totalmente confiável.
--   - claim_ai_reply_slot: único caller real é
--     src/lib/ai/auto-reply.ts:176 (`db.rpc('claim_ai_reply_slot',
--     ...)`), onde `db = supabaseAdmin()` é atribuído internamente na
--     própria função (linha 49) — sempre service_role, mesmo raciocínio
--     de auth.uid() acima. A própria migration 029 (comentário
--     original, linha 133-141) e a 031 (que só adicionou o GRANT que
--     faltava) já documentam a intenção de "service_role apenas" desde
--     o início — essa migration só fecha o REVOKE que nunca foi escrito.
--
-- IDEMPOTÊNCIA: CREATE OR REPLACE FUNCTION substitui o corpo inteiro;
-- REVOKE/GRANT são no-op quando já aplicados. Seguro reexecutar.
-- ============================================================

-- ============================================================
-- 1. _bcast_bump(bid, col, delta)
--
-- Achado: SECURITY DEFINER sem REVOKE (PUBLIC executável por
-- default); `col` interpolado via format('%I', col) sem whitelist —
-- identifier-escaping impede SQL injection, mas não impede alguém
-- com EXECUTE de apontar para QUALQUER coluna de `broadcasts` (ex.:
-- uma coluna que não é contador). Sem caller externo legítimo (ver
-- análise de callers acima) — REVOKE total é a correção correta,
-- sem introduzir GRANT nenhum.
--
-- Whitelist: as únicas 5 colunas que este mecanismo de contador já
-- usa, extraídas diretamente do corpo de
-- _bcast_cols_for_status() (005) — não inventadas: cada branch dessa
-- função só retorna sent_count/delivered_count/read_count/
-- replied_count/failed_count, os mesmos 5 nomes que
-- recompute_broadcast_counts (003/005) escreve e que existem como
-- colunas INTEGER em `broadcasts` (001, linhas 305-309).
-- ============================================================
CREATE OR REPLACE FUNCTION public._bcast_bump(bid UUID, col TEXT, delta INT)
RETURNS VOID AS $$
BEGIN
  IF col NOT IN ('sent_count', 'delivered_count', 'read_count', 'replied_count', 'failed_count') THEN
    RAISE EXCEPTION '_bcast_bump: invalid column %', col
      USING ERRCODE = '22023'; -- invalid_parameter_value
  END IF;

  EXECUTE format(
    'UPDATE public.broadcasts SET %I = GREATEST(0, %I + $1), updated_at = NOW() WHERE id = $2',
    col, col
  ) USING delta, bid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Nenhum GRANT: só chamada internamente por outra função SECURITY
-- DEFINER (broadcast_recipient_aggregate_trigger), que não precisa de
-- EXECUTE explícito para chamá-la — herda o privilégio do OWNER da
-- função chamadora. REVOKE de service_role também é seguro: nenhum
-- código da aplicação chama _bcast_bump diretamente.
REVOKE ALL ON FUNCTION public._bcast_bump(UUID, TEXT, INT) FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================
-- 2. recompute_broadcast_counts(bid)
--
-- Achado: mesmo problema de grant (SECURITY DEFINER sem REVOKE).
-- Fórmula/colunas/retorno idênticos ao original (003, replicado em
-- 005) — só qualificação de schema + search_path + grants mudam.
-- ============================================================
CREATE OR REPLACE FUNCTION public.recompute_broadcast_counts(bid UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE public.broadcasts b SET
    sent_count      = agg.sent_count,
    delivered_count = agg.delivered_count,
    read_count      = agg.read_count,
    replied_count   = agg.replied_count,
    failed_count    = agg.failed_count,
    updated_at      = NOW()
  FROM (
    SELECT
      COUNT(*) FILTER (WHERE status IN ('sent','delivered','read','replied')) AS sent_count,
      COUNT(*) FILTER (WHERE status IN ('delivered','read','replied'))        AS delivered_count,
      COUNT(*) FILTER (WHERE status IN ('read','replied'))                    AS read_count,
      COUNT(*) FILTER (WHERE status = 'replied')                              AS replied_count,
      COUNT(*) FILTER (WHERE status = 'failed')                               AS failed_count
    FROM public.broadcast_recipients
    WHERE broadcast_id = bid
  ) agg
  WHERE b.id = bid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- GRANT a service_role preservado — comentário original (005) a
-- documenta como "safety net" para ops rodarem manualmente; um
-- superusuário conectado direto (ex.: SQL Editor do Supabase) nunca
-- depende de GRANT para executar, então isso não abre nada novo, só
-- preserva o caminho já documentado via service_role.
REVOKE ALL ON FUNCTION public.recompute_broadcast_counts(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_broadcast_counts(UUID) TO service_role;

-- ============================================================
-- 3. record_webhook_failure(endpoint_id, max_failures)
--
-- Achado: SECURITY DEFINER sem NENHUM GRANT/REVOKE desde a criação
-- (028) — PUBLIC executável por default, incluindo `anon`. Único
-- caller real confirmado: src/lib/webhooks/deliver.ts, sempre via
-- supabaseAdmin() (service_role) — ver análise de callers no
-- cabeçalho. UPDATE/CASE/WHERE idênticos ao original, só qualificação
-- de schema + search_path + grants mudam.
-- ============================================================
CREATE OR REPLACE FUNCTION public.record_webhook_failure(
  endpoint_id uuid,
  max_failures int
)
RETURNS void AS $$
  UPDATE public.webhook_endpoints
  SET failure_count = failure_count + 1,
      is_active = CASE
        WHEN failure_count + 1 >= max_failures THEN false
        ELSE is_active
      END
  WHERE id = endpoint_id;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = '';

REVOKE ALL ON FUNCTION public.record_webhook_failure(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_webhook_failure(uuid, int) TO service_role;

-- ============================================================
-- 4. claim_ai_reply_slot(conversation_id, max_replies)
--
-- Achado: GRANT a service_role já existe (029, reafirmado em 031),
-- mas o REVOKE de PUBLIC nunca foi escrito — a própria 031 documenta
-- a intenção "service_role apenas" sem nunca ter fechado o acesso
-- default. WITH/UPDATE/RETURNING idênticos ao original, só
-- qualificação de schema + search_path mudam; GRANT a service_role
-- reafirmado apenas por idempotência (já existia).
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  conversation_id uuid,
  max_replies integer
)
RETURNS boolean AS $$
  WITH claimed AS (
    UPDATE public.conversations
    SET ai_reply_count = ai_reply_count + 1
    WHERE id = conversation_id
      AND ai_reply_count < max_replies
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = '';

REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;

-- ============================================================
-- VALIDAÇÃO MANUAL — rodar contra staging, nunca produção, antes de
-- aplicar em produção. Script completo e separado em
-- supabase/validation/067_security_definer_hardening_check.sql
-- (não faz parte desta migration, não é aplicado por ela).
-- ============================================================
