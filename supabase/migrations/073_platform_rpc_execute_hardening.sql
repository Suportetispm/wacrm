-- ============================================================
-- 073_platform_rpc_execute_hardening
--
-- Extensão do hardening iniciado em 072 (que corrigiu só
-- platform_set_account_feature) para as 5 RPCs administrativas de
-- plataforma mais antigas, com o MESMO gap confirmado em produção:
-- EXECUTE direto para `anon` (causa-raiz já confirmada em
-- pg_default_acl — default privilege do schema public concede
-- EXECUTE a anon em toda função nova, no momento do CREATE FUNCTION,
-- antes de qualquer REVOKE que a própria migration emita depois).
--
--   grant_platform_admin(UUID)                  — 046
--   revoke_platform_admin(UUID)                 — 046
--   platform_create_account(TEXT, UUID)          — 047
--   platform_update_account(UUID, TEXT)          — 047
--   platform_set_account_active(UUID, BOOLEAN)   — 047
--
-- AUDITORIA PRÉVIA (feita antes desta migration — ver relatório da
-- etapa para o detalhe completo):
--   - assinaturas acima confirmadas por grep em TODO
--     supabase/migrations/*.sql — cada uma definida uma única vez,
--     sem overload, nunca redefinida por migration posterior;
--   - platform_create_account/platform_update_account/
--     platform_set_account_active: usadas hoje em
--     src/app/api/admin/accounts/route.ts e
--     src/app/api/admin/accounts/[id]/route.ts, sempre via client
--     RLS-scoped (createClient(), sessão do usuário) — sempre como
--     `authenticated`, nunca `anon`, nunca `service_role`;
--   - grant_platform_admin/revoke_platform_admin: zero chamadas em
--     src/ hoje. docs/platform-admin-bootstrap.md confirma que o
--     único uso documentado é (a) bootstrap único via INSERT direto
--     no SQL Editor como superuser `postgres` (não usa a RPC), ou
--     (b) uso normal futuro por um platform admin já autenticado —
--     sempre `authenticated`. Nenhum caminho legítimo, documentado ou
--     em uso, depende de `anon`.
--
-- ESCOPO DELIBERADAMENTE FORA DESTA MIGRATION:
--   - is_platform_admin() (046) já revoga de anon explicitamente
--     desde sua própria migration original — não precisa de ajuste;
--   - account_has_any_data(UUID) (047) tem o mesmo padrão
--     "REVOKE ALL FROM PUBLIC" sem revoke explícito de anon, e
--     PROVAVELMENTE tem o mesmo gap — mas não foi confirmado por
--     consulta de ACL em produção (só as 5 RPCs acima foram),
--     então não é tocada aqui. Fica registrada como candidata a uma
--     próxima rodada de hardening, não corrigida por suposição;
--   - pg_default_acl (a causa-raiz) NÃO é alterado nesta migration —
--     decisão registrada em separado (ver relatório desta etapa).
--
-- NENHUMA alteração de corpo de função, owner, SECURITY DEFINER ou
-- search_path — só REVOKE/GRANT sobre as 5 funções já existentes.
-- Nenhuma delas é recriada (nenhum CREATE OR REPLACE FUNCTION aqui).
-- Idempotente: seguro rodar mais de uma vez no mesmo ambiente.
-- ------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION public.grant_platform_admin(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.grant_platform_admin(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.grant_platform_admin(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.revoke_platform_admin(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.revoke_platform_admin(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_platform_admin(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.platform_create_account(TEXT, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.platform_create_account(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_create_account(TEXT, UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.platform_update_account(UUID, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.platform_update_account(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_update_account(UUID, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.platform_set_account_active(UUID, BOOLEAN) FROM anon;
REVOKE EXECUTE ON FUNCTION public.platform_set_account_active(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_set_account_active(UUID, BOOLEAN) TO authenticated;

-- service_role e postgres NÃO são tocados aqui — mesma decisão de
-- 072: ambos são caminhos administrativos/server-only por construção
-- do projeto (service_role bypassa RLS por definição; postgres é o
-- owner de todas as 5 funções e sempre pode executar as próprias
-- funções, independente de GRANT).

-- ============================================================
-- VALIDAÇÃO MANUAL — ver supabase/validation/
-- 073_platform_rpc_execute_hardening_check.sql. NÃO executado
-- automaticamente por esta migration.
-- ============================================================
