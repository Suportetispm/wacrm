-- ============================================================
-- 074_rpc_execute_hardening
--
-- Fecha o mesmo gap de EXECUTE-para-`anon` já corrigido em 072
-- (platform_set_account_feature) e 073 (grant_platform_admin,
-- revoke_platform_admin, platform_create_account,
-- platform_update_account, platform_set_account_active) — desta vez
-- para as 12 funções identificadas na auditoria geral de migrations
-- (WACRM_AUDITORIA_MIGRATIONS_073.md, Parte 4) com o mesmo padrão:
-- criadas só com `REVOKE ALL ... FROM PUBLIC` (ou, em 2 casos, nem
-- isso), sem `REVOKE ... FROM anon` explícito.
--
-- AUDITORIA PRÉVIA (fonte primária — leitura direta de cada migration
-- de criação/redefinição, não resumo de terceiros):
--
--   018_account_member_rpcs.sql -> set_member_role(uuid,
--     account_role_enum), remove_account_member(uuid),
--     transfer_account_ownership(uuid): todas SECURITY DEFINER, todas
--     com `IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized'`
--     como primeira checagem, mais validação de role (admin+ ou
--     owner) e de tenancy do alvo. Grants: só `REVOKE ALL FROM
--     PUBLIC` + `GRANT EXECUTE TO authenticated`. Callers confirmados:
--     src/app/api/account/members/[userId]/route.ts (PATCH/DELETE,
--     via `ctx.supabase` — client RLS-scoped, sessão do usuário) e
--     src/app/api/account/transfer-ownership/route.ts (POST, mesmo
--     padrão). Nenhum caminho `anon`.
--
--   022_contact_phone_dedup.sql -> merge_duplicate_contacts(): SECURITY
--     DEFINER, ZERO checagem de identidade no corpo (nenhum
--     `auth.uid()`), opera em loop sobre TODAS as contas de uma vez
--     (cross-tenant por desenho — é um utilitário de limpeza, não uma
--     RPC de produto). Grants: só `REVOKE ALL FROM PUBLIC`, SEM
--     NENHUM GRANT a ninguém. Chamada uma única vez, inline, na
--     própria migration 022 (`SELECT public.merge_duplicate_contacts();`).
--     ZERO callers em src/** (confirmado por grep exaustivo) — não é
--     invocada pela aplicação, nunca foi.
--
--   024_member_presence.sql -> touch_presence(text): SECURITY DEFINER,
--     `IF auth.uid() IS NULL THEN RAISE EXCEPTION` presente, resolve a
--     conta a partir do PRÓPRIO profile do chamador (nunca aceita
--     account_id do cliente). Grants: NENHUM REVOKE/GRANT foi jamais
--     emitido para esta função em nenhuma migration — depende
--     inteiramente do privilégio padrão do schema. Caller confirmado:
--     src/components/presence/presence-heartbeat.tsx (client
--     `"use client"`, via `createClient()` do browser — sessão do
--     usuário, sempre `authenticated`).
--
--   036_conversation_contact_dedup.sql -> merge_duplicate_conversations():
--     mesmo shape exato de merge_duplicate_contacts (022) — SECURITY
--     DEFINER, zero checagem de identidade, cross-tenant por desenho,
--     só `REVOKE ALL FROM PUBLIC`, zero callers em src/**.
--
--   047_platform_account_management.sql (redefinida em 048) ->
--     is_account_member(uuid, account_role_enum DEFAULT 'viewer'):
--     helper de leitura (retorna boolean), SECURITY DEFINER, `SET
--     search_path = public`. Grant original (017): `GRANT EXECUTE ...
--     TO authenticated, service_role` — **nunca teve um `REVOKE ALL
--     FROM PUBLIC`**, em nenhuma das 3 definições (017/047/048).
--     Severidade baixa (o corpo depende de `auth.uid()` — para um
--     chamador `anon`/sem JWT, `auth.uid()` resolve NULL e a função
--     sempre retorna `false`; não expõe dado além do booleano), mas
--     fechada aqui por consistência com o padrão já adotado desde 067.
--
--   048_platform_user_management.sql -> platform_attach_user_to_account
--     (uuid,uuid,account_role_enum,text,uuid[]),
--     platform_update_user(uuid,text,account_role_enum,boolean,uuid[]):
--     SECURITY DEFINER, `IF v_caller_id IS NULL` + `IF NOT
--     is_platform_admin()` como primeiras duas checagens — mesma
--     família de risco das 5 RPCs de plataforma já corrigidas em 073,
--     mas ficaram de fora daquela migration por não terem sido
--     identificadas na auditoria original. Grants: só `REVOKE ALL
--     FROM PUBLIC` + `GRANT EXECUTE TO authenticated`. Callers
--     confirmados: src/app/api/admin/users/route.ts (POST) e
--     src/app/api/admin/users/[id]/route.ts (PATCH), ambos via client
--     RLS-scoped (comentário do próprio arquivo confirma
--     "RLS-scoped client — platform_update_user validates auth.uid()
--     by...").
--
--   049_ticket_operations.sql -> mark_ticket_waiting_customer(uuid),
--     resume_ticket(uuid), close_ticket(uuid,text,boolean): SECURITY
--     DEFINER, `IF v_caller_id IS NULL`, checagem de
--     `profiles.is_active`/`accounts.is_active`, checagem de role
--     (owner/admin/agent) e de atribuição do ticket. Grants: só
--     `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO authenticated`. As
--     3 irmãs do mesmo arquivo (claim_ticket, transfer_ticket_queue,
--     transfer_ticket_agent) JÁ foram corrigidas em
--     068_ticket_conversation_assignee_sync.sql (que as redefiniu por
--     outro motivo e reafirmou os grants) — estas 3 não, porque 068
--     não teve motivo de negócio para tocá-las. Callers confirmados:
--     src/app/api/tickets/[id]/{waiting-customer,resume,close}/route.ts,
--     todos via `getCurrentAccount()` (client RLS-scoped).
--
-- EXCLUÍDA DESTA MIGRATION (controle, não risco):
--   account_has_any_data(uuid) (047, REDEFINIDA em 055) — a migration
--   055 já aplicou `REVOKE ALL FROM PUBLIC, anon, authenticated,
--   service_role` explicitamente (nenhuma role de cliente tem
--   EXECUTE, só chamável internamente por outras funções SECURITY
--   DEFINER do mesmo owner). A auditoria geral anterior
--   (WACRM_AUDITORIA_MIGRATIONS_073.md) listou esta função como
--   "RISCO POTENCIAL" por ter lido só a definição original de 047 sem
--   notar que 055 a redefiniu com o REVOKE completo — correção
--   registrada aqui; NENHUMA alteração é necessária ou feita para
--   esta função.
--
-- NENHUM corpo de função é alterado (nenhum `CREATE OR REPLACE
-- FUNCTION` nesta migration — só `REVOKE`/`GRANT` sobre as funções já
-- existentes). NENHUMA tabela, RLS, dado ou UAZAPI/Meta/Inbox/Flow/
-- Automations/whatsapp_config/conversations/account_feature_flags é
-- tocado. Nenhum comando genérico `ALL FUNCTIONS IN SCHEMA` — cada
-- REVOKE/GRANT nomeia a assinatura exata.
-- ------------------------------------------------------------

-- ============================================================
-- GRUPO A — CRÍTICA/ALTA: utilitários de manutenção sem caller na
-- aplicação e sem checagem de identidade no corpo. Não recebem GRANT
-- a NENHUMA role de cliente (nem authenticated) — não são RPCs de
-- produto, são ferramentas pontuais de correção de dados que só
-- fazem sentido chamadas manualmente por um operador com acesso
-- direto ao Postgres (que bypassa GRANT/REVOKE como owner/superuser).
-- Revoga-se de `anon` E de `authenticated` (defesa em profundidade
-- contra o mesmo default privilege de schema, que pode afetar as duas
-- roles, não comprovadamente só `anon`).
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.merge_duplicate_contacts() FROM anon;
REVOKE EXECUTE ON FUNCTION public.merge_duplicate_contacts() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.merge_duplicate_contacts() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.merge_duplicate_conversations() FROM anon;
REVOKE EXECUTE ON FUNCTION public.merge_duplicate_conversations() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC;

-- ============================================================
-- GRUPO B — MÉDIA: RPCs de produto com checagem interna forte
-- (auth.uid()/is_platform_admin()/role/tenancy), só faltando o
-- REVOKE explícito de `anon`. Reafirma authenticated (mesmo padrão de
-- 072/073) — nenhuma mudança de comportamento para o caminho legítimo.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.platform_attach_user_to_account(UUID, UUID, account_role_enum, TEXT, UUID[]) FROM anon;
REVOKE EXECUTE ON FUNCTION public.platform_attach_user_to_account(UUID, UUID, account_role_enum, TEXT, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_attach_user_to_account(UUID, UUID, account_role_enum, TEXT, UUID[]) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.platform_update_user(UUID, TEXT, account_role_enum, BOOLEAN, UUID[]) FROM anon;
REVOKE EXECUTE ON FUNCTION public.platform_update_user(UUID, TEXT, account_role_enum, BOOLEAN, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_update_user(UUID, TEXT, account_role_enum, BOOLEAN, UUID[]) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.set_member_role(UUID, account_role_enum) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_member_role(UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, account_role_enum) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.remove_account_member(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.transfer_account_ownership(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.transfer_account_ownership(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.mark_ticket_waiting_customer(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.mark_ticket_waiting_customer(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_ticket_waiting_customer(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.resume_ticket(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.resume_ticket(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resume_ticket(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.close_ticket(UUID, TEXT, BOOLEAN) FROM anon;
REVOKE EXECUTE ON FUNCTION public.close_ticket(UUID, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_ticket(UUID, TEXT, BOOLEAN) TO authenticated;

-- touch_presence nunca teve NENHUM REVOKE/GRANT — precisa dos três
-- comandos (REVOKE PUBLIC não é redundante aqui, ao contrário das
-- funções acima).
REVOKE EXECUTE ON FUNCTION public.touch_presence(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.touch_presence(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_presence(TEXT) TO authenticated;

-- ============================================================
-- GRUPO C — BAIXA: helper de leitura, corpo já seguro para `anon`
-- (auth.uid() NULL -> sempre false), mas nunca teve REVOKE FROM
-- PUBLIC em nenhuma das 3 definições (017/047/048). Fecha por
-- consistência; GRANT a authenticated/service_role é reafirmado
-- idêntico ao que já existe desde 017 — nenhuma mudança de
-- comportamento para o caminho legítimo (RLS de todo o produto
-- depende desta função).
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.is_account_member(UUID, account_role_enum) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_account_member(UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_account_member(UUID, account_role_enum) TO authenticated, service_role;

-- service_role e postgres não são tocados em nenhum grupo acima —
-- mesma decisão de 072/073: ambos são caminhos administrativos/
-- server-only por construção do projeto.

-- ============================================================
-- VALIDAÇÃO MANUAL — ver supabase/validation/
-- 074_rpc_execute_hardening_check.sql. NÃO executado automaticamente
-- por esta migration. Rodar supabase/validation/
-- 074_platform_rpc_preflight_check.sql ANTES de aplicar esta
-- migration, para confirmar contra o banco real (não só o
-- código-fonte) que nenhuma função tem um grant a `anon` diferente
-- do previsto aqui.
-- ============================================================
