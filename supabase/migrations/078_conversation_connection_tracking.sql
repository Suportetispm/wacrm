-- ============================================================
-- 078_conversation_connection_tracking  (ETAPA 078A)
--
-- Prepara `conversations` para saber por qual conexão (whatsapp_config)
-- a conversa acontece — SEM mudar ainda a identidade da conversa.
--
-- CONTEXTO
--   077 removeu UNIQUE(account_id) de whatsapp_config: uma account pode
--   ter várias conexões. Mas conversations continua única por
--   (account_id, contact_id) (idx_conversations_account_contact, 036),
--   e nada no banco diz por qual número a conversa acontece — todo
--   outbound sai pela conexão "primária" da account. A 078 como um todo
--   leva a identidade para (account_id, contact_id, whatsapp_config_id);
--   esta 078A é só a fundação, 100% backward-compatible:
--
--     - NENHUM caller muda (inbound, outbound, Flow, Inbox, API) —
--       todos continuam inserindo conversations sem whatsapp_config_id
--       (NULL) e buscando por (account_id, contact_id);
--     - idx_conversations_account_contact FICA — continua sendo a
--       identidade vigente. A UNIQUE parcial nova abaixo só prepara o
--       schema futuro e, enquanto a antiga existir, nunca pode ser
--       violada (é estritamente mais fraca que ela);
--     - nenhuma policy RLS muda.
--
-- O QUE ESTA MIGRATION FAZ
--   1. whatsapp_config: UNIQUE(id, account_id) — alvo da FK composta.
--      Redundante como unicidade (id já é PK), existe só para que a FK
--      possa amarrar a account.
--   2. conversations.whatsapp_config_id UUID NULL.
--   3. FK composta (whatsapp_config_id, account_id) →
--      whatsapp_config(id, account_id), ON DELETE/UPDATE NO ACTION.
--      PROTEÇÃO CROSS-ACCOUNT declarativa: uma conversation da account
--      A nunca pode apontar para uma conexão da account B — o próprio
--      Postgres rejeita (23503), para qualquer caller (authenticated,
--      service_role, RPC), sem depender de TypeScript/UI. MATCH SIMPLE
--      (default): whatsapp_config_id NULL não é checado — é o estado
--      legado/transitório permitido.
--   4. idx_conversations_whatsapp_config (parcial, NOT NULL) — lookups
--      por conexão e o check de FK no delete de whatsapp_config.
--   5. idx_conversations_account_contact_config — UNIQUE parcial
--      (account_id, contact_id, whatsapp_config_id) WHERE NOT NULL.
--      Futura identidade (078D). Hoje é inofensiva.
--   6. conversations_enforce_privilege_columns (076): whatsapp_config_id
--      entra na lista de colunas que `authenticated` não pode alterar
--      via UPDATE direto — senão um agent poderia trocar o número pelo
--      qual a conversa responde. service_role e RPCs SECURITY DEFINER
--      (current_user <> 'authenticated') seguem livres, igual às demais.
--   7. Backfill DETERMINÍSTICO — só accounts com EXATAMENTE 1
--      whatsapp_config (ver seção própria).
--
-- NO ACTION (e não RESTRICT/SET NULL/CASCADE) — decisão da auditoria 078:
--   - CASCADE apagaria histórico de conversa junto com a conexão. Nunca.
--   - SET NULL faria a conversa perder o vínculo em silêncio e, a partir
--     da 078C, responder pela conexão primária — exatamente o bug que a
--     078 existe para fechar.
--   - RESTRICT é checado na hora e pode quebrar o DELETE em cascata de
--     accounts (accounts→whatsapp_config e accounts→conversations são
--     ambos CASCADE, ordem não garantida). NO ACTION é checado no fim
--     do statement — quando o cascade de account terminou, as
--     conversations também já foram, e o delete passa.
--
-- IMPACTO OPERACIONAL — LER ANTES DE APLICAR
--   (a) DELETE de whatsapp_config referenciada passa a falhar (23503).
--       Após o backfill, toda conexão única de account com conversas
--       fica referenciada. Rotas afetadas (NÃO alteradas aqui — mudança
--       operacional é da 078E, com soft-delete/arquivamento):
--         - DELETE /api/whatsapp/config ("Reset Configuration") → 500;
--         - DELETE /api/uazapi/instance, ramo sem credenciais Meta
--           dormentes → 500;
--         - UI "Recriar instância" (DELETE + POST) → para no DELETE.
--       Nenhum dado é perdido: o delete falha inteiro. O ramo "restaurar
--       Meta" do DELETE UAZAPI é UPDATE, não DELETE — não é afetado.
--       Recuperação manual via service_role, se necessária: ver
--       relatório da 078A.
--   (b) Realtime: conversations está em supabase_realtime. O UPDATE do
--       backfill emite um evento por linha. Inbox aberta que recebe
--       UPDATE de conversa que não está na lista chama
--       hydrateConversation (1 fetch por conversa) e a insere na lista
--       daquela aba até o reload. Aplicar em janela de baixo uso e
--       orientar reload das Inboxes abertas. O preflight informa o
--       volume (will_be_backfilled).
--   (c) set_updated_at dispara no backfill: updated_at das conversas
--       preenchidas vira now(). Nenhuma query do app ordena
--       conversations por updated_at (last_message_at é o que ordena);
--       efeito cosmético.
--   (d) Locks: ADD CONSTRAINT em whatsapp_config (ACCESS EXCLUSIVE,
--       tabela pequena); ADD FK + CREATE INDEX em conversations
--       (bloqueiam escrita durante a construção — tabela pequena/média).
--       Inbound que chegar nesse intervalo espera; nada é perdido.
--
-- BACKFILL — por que "exatamente 1 config" é determinístico
--   Hoje (antes da 078C) TODO outbound de TODA conversation sai por
--   loadActiveWhatsAppConfig(account) — a conexão primária da account.
--   Numa account com exatamente 1 whatsapp_config, essa linha é, por
--   definição, a conexão pela qual cada conversa dessa account responde
--   hoje. Preencher whatsapp_config_id com ela reproduz exatamente o
--   comportamento operacional atual — não é um palpite de "primeira
--   conexão". Ressalva registrada na auditoria: whatsapp_config.id já
--   mudou de número/provider in-place no passado (save Meta com outro
--   phone_number_id, upgrade Meta→UAZAPI pré-077B, restore UAZAPI→Meta),
--   então isto prova a conexão OPERACIONAL, não o número histórico de
--   cada mensagem antiga.
--   Accounts com 0 configs ou >1 configs: NULL (permitido pela FK).
--   Idempotente: só toca linhas ainda NULL; reexecutar é no-op para as
--   já preenchidas e completa novas conversas (NULL) das mesmas accounts.
--
-- Pré-requisito: 077 aplicada. Rodar antes
--   supabase/validation/078a_conversation_connection_preflight.sql.
-- Validação: supabase/validation/078a_conversation_connection_check.sql.
-- Idempotente — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1) whatsapp_config: UNIQUE(id, account_id) — alvo da FK composta
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.whatsapp_config'::regclass
      AND conname = 'whatsapp_config_id_account_key'
  ) THEN
    ALTER TABLE public.whatsapp_config
      ADD CONSTRAINT whatsapp_config_id_account_key UNIQUE (id, account_id);
  END IF;
END $$;

-- ============================================================
-- 2) conversations.whatsapp_config_id — nullable durante a transição
-- ============================================================
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID NULL;

COMMENT ON COLUMN public.conversations.whatsapp_config_id IS
  'Conexão (whatsapp_config) pela qual esta conversa acontece. NULL = legado/não determinado (078A). FK composta com account_id impede conexão de outra account.';

-- ============================================================
-- 3) FK composta — proteção cross-account, NO ACTION
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.conversations'::regclass
      AND conname = 'conversations_whatsapp_config_account_fkey'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_whatsapp_config_account_fkey
      FOREIGN KEY (whatsapp_config_id, account_id)
      REFERENCES public.whatsapp_config (id, account_id)
      ON DELETE NO ACTION
      ON UPDATE NO ACTION;
  END IF;
END $$;

-- ============================================================
-- 4/5) Índices parciais
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config
  ON public.conversations (whatsapp_config_id)
  WHERE whatsapp_config_id IS NOT NULL;

-- Futura identidade (078D). Enquanto idx_conversations_account_contact
-- existir, esta nunca é violada.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_config
  ON public.conversations (account_id, contact_id, whatsapp_config_id)
  WHERE whatsapp_config_id IS NOT NULL;

-- ============================================================
-- 6) Proteção de coluna — 076 + whatsapp_config_id
--    Corpo idêntico ao da 076; única mudança: whatsapp_config_id na
--    condição e na mensagem. O trigger enforce_privilege_columns (076,
--    BEFORE UPDATE sem lista de colunas) já cobre a coluna nova — não
--    precisa ser recriado.
-- ============================================================
CREATE OR REPLACE FUNCTION public.conversations_enforce_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (
    NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.queue_id IS DISTINCT FROM OLD.queue_id
    OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.unread_count IS DISTINCT FROM OLD.unread_count
    OR NEW.whatsapp_config_id IS DISTINCT FROM OLD.whatsapp_config_id
  )
  AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_id, queue_id, contact_id, user_id, created_at, unread_count and whatsapp_config_id cannot be changed directly; use Flow routing, the ticket RPCs, or mark_conversation_read'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Mesmo padrão da 076: função de trigger não precisa de EXECUTE para
-- nenhuma role (o motor de trigger a invoca sem passar por ACL).
REVOKE EXECUTE ON FUNCTION public.conversations_enforce_privilege_columns() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.conversations_enforce_privilege_columns() FROM anon;
REVOKE EXECUTE ON FUNCTION public.conversations_enforce_privilege_columns() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.conversations_enforce_privilege_columns() FROM service_role;

-- ============================================================
-- 7) Backfill determinístico — só accounts com EXATAMENTE 1 config
--
--    LOCK em whatsapp_config (SHARE ROW EXCLUSIVE: bloqueia INSERT/
--    UPDATE/DELETE concorrentes, permite leitura) até o fim da
--    transação — ninguém cria uma 2ª conexão entre "contar configs" e
--    "gravar o backfill". Numa primeira execução o ADD CONSTRAINT acima
--    já segura um lock mais forte; o LOCK explícito cobre a reexecução.
--    Dentro de DO para rodar mesmo fora de BEGIN/COMMIT explícito.
-- ============================================================
DO $$
DECLARE
  v_backfilled INTEGER;
  v_still_null INTEGER;
BEGIN
  LOCK TABLE public.whatsapp_config IN SHARE ROW EXCLUSIVE MODE;

  WITH single_config AS (
    SELECT account_id, (array_agg(id))[1] AS config_id
    FROM public.whatsapp_config
    GROUP BY account_id
    HAVING count(*) = 1
  )
  UPDATE public.conversations c
  SET whatsapp_config_id = s.config_id
  FROM single_config s
  WHERE c.account_id = s.account_id
    AND c.whatsapp_config_id IS NULL;

  GET DIAGNOSTICS v_backfilled = ROW_COUNT;

  SELECT count(*) INTO v_still_null
  FROM public.conversations
  WHERE whatsapp_config_id IS NULL;

  RAISE NOTICE '078A backfill: % conversation(s) preenchidas; % permanecem NULL (accounts com 0 ou >1 conexões)',
    v_backfilled, v_still_null;
END $$;

-- ============================================================
-- VALIDAÇÃO MANUAL — ver
-- supabase/validation/078a_conversation_connection_check.sql.
-- NÃO executado automaticamente por esta migration.
-- ============================================================
