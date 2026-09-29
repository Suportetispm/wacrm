-- ============================================================
-- 077_whatsapp_config_multiconnection_preflight_check.sql
--
-- Verificação SOMENTE LEITURA — segura em produção. Roda ANTES de
-- decidir se/quando aplicar a migration 077 (que, nesta rodada,
-- ainda NÃO foi criada — ver relatório da etapa: a auditoria de
-- código encontrou dependências reais de "0 ou 1 linha por
-- account_id" que precisam ser corrigidas em TypeScript primeiro).
--
-- Este script é útil independente disso — documenta o estado real
-- da tabela e serve de linha de base para quando a migration for
-- escrita.
-- ============================================================

-- Definição completa da tabela (colunas, tipos, defaults, nullable)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'whatsapp_config'
ORDER BY ordinal_position;

-- Todas as constraints (PK, UNIQUE, CHECK, FK) com definição completa
-- e nome REAL — não presumir nomes.
SELECT conname, contype,
  CASE contype
    WHEN 'p' THEN 'PRIMARY KEY' WHEN 'u' THEN 'UNIQUE'
    WHEN 'c' THEN 'CHECK' WHEN 'f' THEN 'FOREIGN KEY' ELSE contype::text
  END AS type_label,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.whatsapp_config'::regclass
ORDER BY contype, conname;
-- Esperado incluir: whatsapp_config_pkey (PK id), whatsapp_config_
-- phone_number_id_key (UNIQUE phone_number_id, 013),
-- whatsapp_config_account_id_key (UNIQUE account_id, 017 — ESTE é o
-- bloqueio a remover), whatsapp_config_status_check (037), FKs de
-- user_id/account_id/default_queue_id.

-- Todos os índices (inclui os criados por constraints UNIQUE + os
-- índices "soltos")
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'whatsapp_config'
ORDER BY indexname;
-- Esperado: idx_whatsapp_config_account (plain, 017 — já existe
-- INDEPENDENTE da UNIQUE, continua útil para busca por account_id
-- depois de remover a UNIQUE, sem precisar recriar nada),
-- idx_whatsapp_config_registered_at (015, parcial),
-- idx_whatsapp_config_default_queue (051, parcial), + os índices
-- implícitos das constraints UNIQUE/PK.

-- RLS habilitada + policies (não devem mudar nesta etapa)
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.whatsapp_config'::regclass;
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'whatsapp_config'
ORDER BY policyname;
-- Esperado: whatsapp_config_select (membro), whatsapp_config_insert/
-- update/delete (admin+) — is_account_member(account_id[,'admin']),
-- sem nenhuma checagem de cardinalidade (RLS não impede uma 2ª linha
-- hoje — só a UNIQUE impede).

-- Triggers existentes
SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgrelid = 'public.whatsapp_config'::regclass AND NOT tgisinternal
ORDER BY tgname;
-- Esperado: set_updated_at (001) + validate_default_queue_account (051).

-- Quantidade de conexões por account HOJE (deve ser sempre 1, dado
-- que a UNIQUE ainda está em vigor — qualquer valor >1 aqui seria
-- uma inconsistência grave a investigar antes de qualquer coisa)
SELECT account_id, count(*) AS connection_count
FROM public.whatsapp_config
GROUP BY account_id
HAVING count(*) > 1;
-- Esperado: 0 linhas.

-- Duplicidade potencial de phone_number_id (já tem UNIQUE própria,
-- 013 — deve vir sempre vazio; NULLs não contam como duplicata)
SELECT phone_number_id, count(*) AS c
FROM public.whatsapp_config
WHERE phone_number_id IS NOT NULL
GROUP BY phone_number_id
HAVING count(*) > 1;
-- Esperado: 0 linhas.

-- Duplicidade potencial de uazapi_instance_id — IMPORTANTE: ao
-- contrário de phone_number_id, esta coluna NÃO tem nenhuma UNIQUE
-- constraint hoje (confirmado por ausência em pg_constraint acima).
-- Isso é relevante para a Fase 4 (proteção de identidade): se já
-- existir alguma duplicata, ela precisa ser resolvida manualmente
-- antes de considerar adicionar uma UNIQUE/índice parcial nesta
-- coluna no futuro.
SELECT uazapi_instance_id, count(*) AS c
FROM public.whatsapp_config
WHERE uazapi_instance_id IS NOT NULL
GROUP BY uazapi_instance_id
HAVING count(*) > 1;
-- Esperado hoje: 0 linhas (mas não é GARANTIDO por constraint,
-- diferente do phone_number_id — vale confirmar).

-- Distribuição por provider (contexto para dimensionar o impacto)
SELECT provider, count(*) AS total, count(DISTINCT account_id) AS distinct_accounts
FROM public.whatsapp_config
GROUP BY provider;

-- Confirma a hipótese central do relatório: nome exato da constraint
-- que bloqueia multiconexão, para uso posterior em
-- ALTER TABLE ... DROP CONSTRAINT <nome exato> (NÃO presumir).
SELECT conname
FROM pg_constraint
WHERE conrelid = 'public.whatsapp_config'::regclass
  AND contype = 'u'
  AND pg_get_constraintdef(oid) ILIKE '%account_id%'
  AND pg_get_constraintdef(oid) NOT ILIKE '%,%'; -- exclui uniques compostas, se houver
-- Esperado: whatsapp_config_account_id_key (confirmado por leitura
-- direta de 017_account_sharing.sql:324-326 nesta auditoria — esta
-- query serve para confirmar contra o banco real, não substitui essa
-- leitura).
