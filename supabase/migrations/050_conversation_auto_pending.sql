-- ============================================================
-- 050_conversation_auto_pending
--
-- Automação de status operacional do Inbox (fase pós-6E.5, antes de
-- qualquer integração Inbox↔tickets): mensagem nova do cliente sempre
-- reabre a conversation para 'pending' — mesmo vinda de closed/
-- finalized — e dá aos caminhos de abertura/varredura no client uma
-- forma segura de checar se uma conversation já tem ticket, sem
-- depender da RLS de `tickets` (que esconde tickets de fila/agente
-- que o chamador não enxerga).
--
-- NÃO altera a migration 049, NÃO cria coluna nova, NÃO cria tabela,
-- NÃO toca tickets.status/tickets.assigned_agent_id em lugar nenhum.
-- Toda conversation com pelo menos um ticket associado fica
-- explicitamente FORA do alcance das mudanças abaixo — quem já tem
-- ticket continua 100% sob as RPCs de 049 (claim_ticket,
-- mark_ticket_waiting_customer, resume_ticket, close_ticket,
-- transfer_ticket_*).
--
-- Conteúdo:
--   1. CREATE OR REPLACE nas 3 RPCs de persistência inbound UAZAPI
--      (038/042/043) — mesma assinatura, mesmo corpo, só adiciona
--      `status` condicional ao UPDATE que elas já fazem.
--   2. ticketed_conversation_ids() — nova, só leitura, devolve os
--      conversation_id com ticket NA CONTA DO CHAMADOR.
--   3. meta_reopen_conversation_on_inbound(...) — nova, substitui o
--      UPDATE solto que o webhook Meta já fazia
--      (src/app/api/whatsapp/webhook/route.ts) por uma única operação
--      atômica. Isso elimina a janela que existiria entre um SELECT
--      "tem ticket?" separado e um UPDATE subsequente no client, e
--      reduz fortemente (sem eliminar em teoria absoluta) a corrida
--      com a criação concorrente de um ticket pela 049 — ver a nota
--      de concorrência junto à definição da função, mais abaixo.
-- ------------------------------------------------------------

-- ============================================================
-- 1a. uazapi_persist_inbound_text_message — só o UPDATE muda.
-- ============================================================
CREATE OR REPLACE FUNCTION public.uazapi_persist_inbound_text_message(
  p_conversation_id UUID,
  p_message_id      TEXT,
  p_content_text    TEXT,
  p_occurred_at     TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_inserted_id  UUID;
  v_updated_rows INTEGER;
BEGIN
  INSERT INTO messages (
    conversation_id, sender_type, content_type, content_text,
    message_id, status, created_at
  ) VALUES (
    p_conversation_id, 'customer', 'text', p_content_text,
    p_message_id, 'delivered', p_occurred_at
  )
  ON CONFLICT (conversation_id, message_id) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    RETURN 'duplicate';
  END IF;

  -- 050: inbound do cliente sempre reabre a conversation para
  -- 'pending' — mesmo vinda de in_progress/waiting_customer/closed/
  -- finalized — EXCETO quando a conversation já tem um ticket
  -- associado, caso em que status fica inteiramente com as RPCs da
  -- 049 (esta função nunca escreve status nesse caso). O NOT EXISTS
  -- roda na mesma statement do UPDATE — isso elimina a janela que
  -- existiria entre um SELECT separado e este UPDATE, e reduz
  -- fortemente a corrida com a criação concorrente de um ticket pela
  -- 049. Não é uma garantia absoluta contra qualquer concorrência
  -- extrema nesse ponto — ver a nota de concorrência junto a
  -- meta_reopen_conversation_on_inbound, mais abaixo neste arquivo.
  UPDATE conversations
  SET unread_count      = unread_count + 1,
      last_message_text = p_content_text,
      last_message_at   = p_occurred_at,
      status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id
        ) THEN 'pending'
        ELSE status
      END,
      updated_at        = now()
  WHERE id = p_conversation_id;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_text_message: target conversation not found for update; message insert rolled back';
  END IF;

  RETURN 'persisted';
END;
$$;

-- ============================================================
-- 1b. uazapi_persist_inbound_document_message — mesma mudança.
-- ============================================================
CREATE OR REPLACE FUNCTION public.uazapi_persist_inbound_document_message(
  p_conversation_id    UUID,
  p_message_id         TEXT,
  p_content_text       TEXT,
  p_occurred_at        TIMESTAMPTZ,
  p_media_storage_path TEXT,
  p_media_file_name    TEXT,
  p_media_mime_type    TEXT,
  p_media_file_size    BIGINT,
  p_media_metadata     JSONB DEFAULT '{}'::jsonb
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_inserted_id  UUID;
  v_updated_rows INTEGER;
BEGIN
  INSERT INTO messages (
    conversation_id, sender_type, content_type, content_text,
    message_id, status, created_at,
    media_storage_path, media_file_name, media_mime_type,
    media_file_size, media_metadata
  ) VALUES (
    p_conversation_id, 'customer', 'document', p_content_text,
    p_message_id, 'delivered', p_occurred_at,
    p_media_storage_path, p_media_file_name, p_media_mime_type,
    p_media_file_size, COALESCE(p_media_metadata, '{}'::jsonb)
  )
  ON CONFLICT (conversation_id, message_id) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    RETURN 'duplicate';
  END IF;

  -- 050: mesma regra de reabertura condicional da versão text acima.
  UPDATE conversations
  SET unread_count      = unread_count + 1,
      last_message_text = p_content_text,
      last_message_at   = p_occurred_at,
      status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id
        ) THEN 'pending'
        ELSE status
      END,
      updated_at        = now()
  WHERE id = p_conversation_id;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_document_message: target conversation not found for update; message insert rolled back';
  END IF;

  RETURN 'persisted';
END;
$$;

-- ============================================================
-- 1c. uazapi_persist_inbound_image_message — mesma mudança.
-- ============================================================
CREATE OR REPLACE FUNCTION public.uazapi_persist_inbound_image_message(
  p_account_id         UUID,
  p_conversation_id    UUID,
  p_message_id         TEXT,
  p_content_text       TEXT,
  p_occurred_at        TIMESTAMPTZ,
  p_media_storage_path TEXT,
  p_media_file_name    TEXT,
  p_media_mime_type    TEXT,
  p_media_file_size    BIGINT,
  p_media_metadata     JSONB DEFAULT '{}'::jsonb
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_conversation_account_id UUID;
  v_inserted_id             UUID;
  v_updated_rows            INTEGER;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: account_id is required';
  END IF;

  IF p_conversation_id IS NULL THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: conversation_id is required';
  END IF;

  IF p_message_id IS NULL OR btrim(p_message_id) = '' THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: message_id is required';
  END IF;

  IF p_media_storage_path IS NULL
     OR btrim(p_media_storage_path) = '' THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: media storage path is required';
  END IF;

  IF p_media_mime_type IS NULL
     OR p_media_mime_type NOT IN (
       'image/jpeg',
       'image/png',
       'image/webp'
     ) THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: unsupported image MIME type';
  END IF;

  IF p_media_file_size IS NULL
     OR p_media_file_size <= 0
     OR p_media_file_size > 20971520 THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: invalid image size';
  END IF;

  SELECT account_id INTO v_conversation_account_id
  FROM conversations
  WHERE id = p_conversation_id;

  IF v_conversation_account_id IS NULL
     OR v_conversation_account_id <> p_account_id THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: conversation account mismatch';
  END IF;

  INSERT INTO messages (
    conversation_id, sender_type, content_type, content_text,
    message_id, status, created_at,
    media_storage_path, media_file_name, media_mime_type,
    media_file_size, media_metadata
  ) VALUES (
    p_conversation_id, 'customer', 'image', p_content_text,
    p_message_id, 'delivered', p_occurred_at,
    p_media_storage_path, p_media_file_name, p_media_mime_type,
    p_media_file_size, COALESCE(p_media_metadata, '{}'::jsonb)
  )
  ON CONFLICT (conversation_id, message_id) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    RETURN 'duplicate';
  END IF;

  -- 050: mesma regra de reabertura condicional da versão text acima.
  UPDATE conversations
  SET unread_count      = unread_count + 1,
      last_message_text = p_content_text,
      last_message_at   = p_occurred_at,
      status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id
        ) THEN 'pending'
        ELSE status
      END,
      updated_at        = now()
  WHERE id = p_conversation_id;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION
      'uazapi_persist_inbound_image_message: target conversation not found for update; message insert rolled back';
  END IF;

  RETURN 'persisted';
END;
$$;

-- ============================================================
-- 2. ticketed_conversation_ids() — existência de ticket, sem
--    vazar conteúdo de ticket nenhum.
--
-- Por que precisa ser SECURITY DEFINER: a RLS de `tickets` (049)
-- restringe SELECT a admin/owner, ou a agent atribuído/membro ativo
-- da fila do ticket — um agent comum não enxerga, via a própria RLS,
-- tickets de outras filas ou não atribuídos a ele. Se o client
-- tentasse checar "essa conversation tem ticket?" com uma query
-- comum contra `tickets`, um agent nessa situação leria "não tem"
-- mesmo quando tem, e a automação desta migration reivindicaria uma
-- conversation que já pertence ao fluxo de tickets — exatamente a
-- dessincronização que esta migration existe para evitar. Esta
-- função ignora a RLS de propósito e faz sua própria checagem de
-- tenancy (via profiles, mesmo padrão de mark_conversation_read),
-- devolvendo só o ID da conversation — nunca status, fila,
-- responsável ou qualquer outro campo do ticket.
--
-- p.is_active / a.is_active: por ser SECURITY DEFINER, esta função
-- ignora a RLS por completo — o que significa que também precisa
-- reproduzir, ela mesma, as mesmas checagens de desativação que
-- is_account_member() já aplica (047/048): um profile desativado
-- (usuário removido operacionalmente, mas a linha ainda existe) ou
-- uma account desativada (empresa suspensa) não deve conseguir listar
-- nada através desta função — mesmo continuando "authenticated" e com
-- um JWT válido. Sem essas duas condições, um usuário desativado
-- continuaria enxergando conversation_ids da própria conta via este
-- caminho específico, mesmo que toda outra RPC/RLS já o bloqueie.
--
-- STABLE (não LANGUAGE sql IMMUTABLE): o resultado depende do
-- conteúdo atual das tabelas `tickets`/`profiles`/`accounts`, não é
-- constante entre statements.
-- ============================================================
CREATE OR REPLACE FUNCTION public.ticketed_conversation_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT t.conversation_id
  FROM tickets t
  JOIN profiles p ON p.account_id = t.account_id
  JOIN accounts a ON a.id = t.account_id
  WHERE p.user_id = auth.uid()
    AND p.is_active
    AND a.is_active;
$$;

ALTER FUNCTION public.ticketed_conversation_ids() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ticketed_conversation_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ticketed_conversation_ids() FROM anon;
REVOKE ALL ON FUNCTION public.ticketed_conversation_ids() FROM service_role;
GRANT EXECUTE ON FUNCTION public.ticketed_conversation_ids() TO authenticated;

-- ============================================================
-- 3. meta_reopen_conversation_on_inbound(...) — substitui o UPDATE
--    solto que o webhook Meta fazia em conversations por uma única
--    operação atômica (mesmo padrão CASE/NOT EXISTS das 3 funções
--    UAZAPI acima).
--
-- NOTA DE CONCORRÊNCIA — o que isto garante, e o que não garante:
--   - Elimina por completo a janela que existiria entre um SELECT
--     "tem ticket?" separado e um UPDATE subsequente no client: essa
--     era a corrida concreta que motivou esta função, e essa
--     categoria de corrida não existe mais aqui — o NOT EXISTS roda
--     dentro da mesma statement SQL que escreve `status`, sob o mesmo
--     snapshot.
--   - Isso reduz fortemente a chance de conversations.status divergir
--     de um ticket criado quase ao mesmo tempo.
--   - NÃO é uma garantia absoluta contra qualquer concorrência
--     extrema (ex.: open_ticket_for_conversation inserindo o ticket
--     em outra sessão no instante exato desta statement) — é uma
--     redução forte da janela de corrida, não uma prova formal de
--     impossibilidade em todo cenário. Endurecer isso (lock explícito,
--     RPC dedicada) fica para uma fase futura, se a prática mostrar
--     necessidade — não implementado agora, por pedido explícito.
--
-- SECURITY INVOKER (não DEFINER): o único chamador é o webhook route
-- via client service_role, que já tem acesso total à tabela — sem
-- gap de privilégio pra DEFINER resolver (mesmo raciocínio das 3
-- funções UAZAPI acima / migration 038).
--
-- unread_count é incrementado dentro da função (unread_count + 1),
-- não recebido como parâmetro — evita a rota carregar um valor
-- possivelmente desatualizado de uma leitura anterior.
-- ============================================================
CREATE OR REPLACE FUNCTION public.meta_reopen_conversation_on_inbound(
  p_conversation_id    UUID,
  p_last_message_text  TEXT,
  p_last_message_at    TIMESTAMPTZ
) RETURNS conversations
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  UPDATE conversations
  SET last_message_text = p_last_message_text,
      last_message_at   = p_last_message_at,
      unread_count      = unread_count + 1,
      status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM tickets WHERE tickets.conversation_id = conversations.id
        ) THEN 'pending'
        ELSE status
      END,
      updated_at = now()
  WHERE id = p_conversation_id
  RETURNING *;
$$;

ALTER FUNCTION public.meta_reopen_conversation_on_inbound(UUID, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.meta_reopen_conversation_on_inbound(UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.meta_reopen_conversation_on_inbound(UUID, TEXT, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.meta_reopen_conversation_on_inbound(UUID, TEXT, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.meta_reopen_conversation_on_inbound(UUID, TEXT, TIMESTAMPTZ) TO service_role;

-- ============================================================
-- VALIDAÇÃO MANUAL (não existe harness de teste SQL automatizado
-- neste repositório — mesmo aviso já registrado em 034/049). Rodar
-- contra staging, nunca produção, antes/depois de aplicar.
--
--  1. uazapi_persist_inbound_*_message, conversation SEM ticket:
--       - status='in_progress' -> mensagem inbound -> status='pending'.
--       - status='waiting_customer' -> idem -> 'pending'.
--       - status='closed' -> idem -> 'pending' (reabre).
--       - status='finalized' -> idem -> 'pending' (reabre).
--       - status='pending' -> idem -> continua 'pending' (no-op visível).
--       - unread_count/last_message_text/last_message_at continuam
--         avançando exatamente como antes desta migration.
--
--  2. uazapi_persist_inbound_*_message, conversation COM ticket
--     (qualquer status de ticket, inclusive closed): status da
--     conversation NUNCA muda por causa da mensagem inbound — só
--     unread_count/last_message_text/last_message_at avançam.
--
--  3. ticketed_conversation_ids():
--       - chamador com profile.is_active=true e account.is_active=true,
--         membro da própria conta, mas NÃO membro da fila nem
--         atribuído a um ticket específico -> o conversation_id
--         daquele ticket aparece mesmo assim (a função ignora a RLS
--         de tickets de propósito).
--       - chamador com profile.is_active=false (usuário desativado
--         operacionalmente, linha ainda existe) -> zero linhas, mesmo
--         tendo tickets reais na própria conta.
--       - chamador cuja account.is_active=false (empresa suspensa)
--         -> zero linhas, mesmo tendo tickets reais na própria conta.
--       - chamador de OUTRA conta -> nunca retorna conversation_id de
--         tickets que não são da conta dele, independentemente de
--         is_active.
--
--  4. meta_reopen_conversation_on_inbound: mesmos casos 1/2 acima,
--     mas via o webhook Meta (rota `/api/whatsapp/webhook`) em vez
--     das RPCs UAZAPI — confirma paridade entre os dois provedores.
-- ============================================================
