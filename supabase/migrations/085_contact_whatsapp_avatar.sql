-- ============================================================
-- 085_contact_whatsapp_avatar
--
-- Foto de perfil do WhatsApp sincronizada por contato (somente
-- contatos individuais via UAZAPI). Duas colunas novas em
-- public.contacts, separadas do `avatar_url` legado (que continua
-- intocado e nunca recebe URL temporária de UAZAPI/WhatsApp):
--
--   whatsapp_avatar_path        caminho do arquivo no bucket PRIVADO
--                               `whatsapp-attachments`, no formato
--                               {account_id}/contacts/{contact_id}/{sha256}.{ext};
--                               NULL = sem foto conhecida (UI mostra iniciais).
--   whatsapp_avatar_checked_at  última consulta concluída a
--                               POST /chat/avatar (com ou sem foto);
--                               controla o intervalo mínimo entre consultas.
--
-- Escrita só pelo servidor (service_role, webhook UAZAPI —
-- src/lib/whatsapp/contact-avatar-sync.ts). Leitura do arquivo só pela
-- rota autenticada GET /api/contacts/[id]/avatar (URL assinada curta).
--
-- Sem mudança de RLS: as policies de contacts (017) já isolam por
-- account_id; as colunas novas herdam o mesmo escopo.
-- Sem mudança de bucket: `whatsapp-attachments` já é privado, 20 MB,
-- e já aceita image/jpeg, image/png e image/webp (043/084).
--
-- Idempotente (ADD COLUMN IF NOT EXISTS).
--
-- NÃO APLICADA nesta etapa — aplicação manual (SQL Editor) após
-- revisão e ANTES do deploy do código que a usa.
-- ============================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS whatsapp_avatar_path TEXT NULL,
  ADD COLUMN IF NOT EXISTS whatsapp_avatar_checked_at TIMESTAMPTZ NULL;

-- ============================================================
-- VALIDAÇÃO MANUAL (somente leitura, após aplicar):
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'contacts'
--     AND column_name IN ('whatsapp_avatar_path', 'whatsapp_avatar_checked_at');
-- Esperado: 2 linhas, text / timestamp with time zone, is_nullable = YES.
-- ============================================================
