-- ============================================================
-- whatsapp_config: support a second connection provider (UAZAPI)
--
-- Why this exists:
--   Until now every whatsapp_config row was implicitly a Meta Cloud
--   API connection (phone_number_id, waba_id, access_token). We're
--   adding UAZAPI — an unofficial, QR-code-based WhatsApp connection
--   — as an alternative a user picks in Settings. Each account still
--   has exactly one active connection (UNIQUE(account_id) is
--   unchanged); `provider` says which shape the rest of the row's
--   fields are in.
--
--   phone_number_id / access_token become nullable because a UAZAPI
--   row never populates them — the app enforces "the right fields
--   for the right provider" instead of the DB.
--
--   status previously only ever held 'connected'/'disconnected'
--   (Meta). UAZAPI instances also pass through 'connecting' (QR
--   shown, waiting for scan) and 'hibernated' (session paused,
--   credentials preserved) — the CHECK constraint widens to allow
--   both without changing Meta's existing values.
--
-- Backfill: every existing row gets provider='meta' by default, so
-- current Meta connections keep working with zero changes.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
    CHECK (provider IN ('meta', 'uazapi')),
  ADD COLUMN IF NOT EXISTS uazapi_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_token TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_name TEXT;

ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL,
  ALTER COLUMN access_token DROP NOT NULL;

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_status_check;

ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_status_check
    CHECK (status IN ('connected', 'disconnected', 'connecting', 'hibernated'));
