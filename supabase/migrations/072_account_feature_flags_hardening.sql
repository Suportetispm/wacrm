-- ============================================================
-- 072_account_feature_flags_hardening
--
-- Correção pontual de um achado de privilégio confirmado em produção
-- depois de aplicar 071_account_feature_flags.sql: a função
-- public.platform_set_account_feature(uuid,text,boolean) está com
-- EXECUTE concedido diretamente a `anon` (confirmado via introspecção
-- de ACL — não é herança de PUBLIC nem de nenhum outro role).
--
-- CAUSA PROVÁVEL (não recriada aqui, só documentada — ver relatório
-- desta etapa para o SQL de diagnóstico opcional): este projeto
-- Supabase provavelmente tem um `ALTER DEFAULT PRIVILEGES IN SCHEMA
-- public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated,
-- service_role` configurado no nível do banco (fora do histórico de
-- migrations deste repo — é um bootstrap comum de projeto Supabase).
-- Esse default de schema concede EXECUTE a `anon` no momento do
-- CREATE FUNCTION, ANTES/independente de qualquer REVOKE que a própria
-- migration emita depois. 071 só fez `REVOKE ALL ... FROM PUBLIC` na
-- função (mesmo padrão de platform_set_account_active, 047) — nunca
-- teve um `REVOKE ... FROM anon` explícito, porque nenhuma das RPCs de
-- plataforma anteriores (grant_platform_admin/revoke_platform_admin,
-- 046; platform_create_account/platform_update_account/
-- platform_set_account_active, 047) precisou disso até agora ser
-- auditado.
--
-- IMPORTANTE — ESCOPO: se a causa acima for confirmada, as RPCs
-- citadas no parágrafo anterior (046/047) provavelmente têm o MESMO
-- gap. Esta migration NÃO as toca — o pedido desta etapa é
-- estritamente `platform_set_account_feature`. Uma varredura e
-- correção equivalente nas RPCs de 046/047 fica registrada aqui como
-- recomendação de follow-up separado, fora de escopo.
--
-- SEVERIDADE PRÁTICA: baixa, não zero. O corpo da função já faz
-- `IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Unauthorized'` como
-- primeiríssima checagem — uma chamada genuinamente anônima (sem JWT
-- válido, que é o que a role `anon` do PostgREST representa) sempre
-- resolve `auth.uid()` como NULL e é barrada ali, mesmo tendo EXECUTE.
-- Ou seja, nenhuma escrita indevida era possível por este caminho —
-- o EXECUTE sobrando é uma superfície desnecessária (violação de
-- menor privilégio), não uma vulnerabilidade explorável hoje. Mesmo
-- assim, fechar por padrão de defesa em profundidade: é exatamente o
-- mesmo raciocínio que já levou is_platform_admin() (046) a revogar
-- de anon explicitamente, mesmo sendo, por si só, inofensiva para um
-- chamador anônimo.
--
-- NENHUMA alteração de corpo de função, tabela, RLS, trigger ou
-- platform_audit_log. Só REVOKE/GRANT na função já existente — a
-- função NÃO é recriada (nenhum CREATE OR REPLACE FUNCTION aqui).
-- ------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION public.platform_set_account_feature(UUID, TEXT, BOOLEAN) FROM anon;

-- Redundante com o que 071 já fez (PUBLIC já confirmado sem EXECUTE
-- na auditoria) — mantido aqui por completude/defesa em profundidade,
-- é um no-op seguro se já estiver revogado.
REVOKE EXECUTE ON FUNCTION public.platform_set_account_feature(UUID, TEXT, BOOLEAN) FROM PUBLIC;

-- Reafirma authenticated — também um no-op seguro se já concedido;
-- garante que esta migration nunca deixa authenticated sem EXECUTE
-- mesmo se rodada isoladamente/fora de ordem por engano.
GRANT EXECUTE ON FUNCTION public.platform_set_account_feature(UUID, TEXT, BOOLEAN) TO authenticated;

-- service_role e postgres NÃO são tocados aqui, por decisão explícita
-- desta etapa: service_role bypassa RLS por definição (mesmo
-- raciocínio de 046/047/071 para toda RPC de plataforma) e postgres é
-- o owner da função (sempre pode executar suas próprias funções,
-- independente de GRANT). Nenhum dos dois é um caminho de escrita
-- ilegítima — ambos já são "server-only"/administrativos por
-- construção do projeto.

-- ============================================================
-- VALIDAÇÃO MANUAL — ver supabase/validation/
-- 072_account_feature_flags_hardening_check.sql. NÃO executado
-- automaticamente por esta migration.
-- ============================================================
