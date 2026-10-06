-- ============================================================
-- 086_conversation_events_check.sql
--
-- Script de validação da migration 086 — NÃO É UMA MIGRATION, não é
-- aplicado por nenhum runner (fora de supabase/migrations/). Rodar
-- manualmente no SQL Editor DEPOIS de aplicar a 086.
--
-- TRÊS PARTES, EXECUTADAS SEPARADAMENTE:
--
--   SEÇÃO A — SOMENTE LEITURA (SELECT / catálogo). Pode ser executada
--   diretamente, em qualquer ambiente — INCLUSIVE PRODUÇÃO —, quantas
--   vezes quiser.
--
--   SEÇÃO B — TESTES MUTÁVEIS. *** NÃO EXECUTAR EM PRODUÇÃO. ***
--   Destinada SOMENTE a ambiente descartável (branch de banco do
--   Supabase / cópia de teste). Mesma política das validações 067/068.
--   Motivo: cria usuários em auth.users e dispara as triggers reais de
--   signup/conta/perfil; não é possível provar, a partir do repositório,
--   a ausência de efeitos externos síncronos (extensões http/dblink,
--   webhooks criados pelo painel, funções intermediárias) no banco de
--   produção. O B0 é só uma proteção adicional para o ambiente de teste,
--   não uma garantia. Copie e execute o bloco da Seção B inteiro,
--   sozinho, no ambiente descartável. Ele:
--     - roda INTEIRO dentro de BEGIN … ROLLBACK (não existe COMMIT
--       neste arquivo);
--     - cria SOMENTE dados sintéticos (prefixo '__086_check__'): 3
--       usuários em auth.users — o handle_new_user (017) cria para
--       cada um a conta e o perfil owner, exatamente como no signup —,
--       2 filas, 1 contato e 1 conversation, todos com UUIDs gerados
--       na própria transação;
--     - NUNCA lê, atualiza, fecha, reabre, transfere ou apaga uma
--       conversation real: todo UPDATE/DELETE é WHERE id = <uuid
--       sintético>;
--     - aborta antes de criar qualquer coisa se encontrar, pelo nome,
--       trigger com efeito externo (pg_net / supabase_functions / http)
--       nas tabelas que ele toca diretamente (B0 — heurística, não
--       recursiva; não cobre tabelas atingidas em cascata);
--     - só usa locks de linha nas linhas sintéticas (nenhum lock de
--       tabela além do ROW EXCLUSIVE comum de INSERT/UPDATE/DELETE);
--     - ao final, ROLLBACK desfaz tudo. Os únicos efeitos que
--       sobrevivem a um ROLLBACK no PostgreSQL são valores de
--       sequência consumidos (inofensivos).
--   Se qualquer verificação falhar, o bloco lança
--   '086 FAIL …' e a transação aborta — nada é gravado (rode
--   ROLLBACK; se o editor deixar a sessão em transação abortada).
--
-- PREMISSAS da Seção B (se alguma não valer, o bloco falha e nada
-- persiste):
--   - o papel do SQL Editor (postgres) pode inserir em auth.users e
--     fazer SET ROLE authenticated / service_role;
--   - auth.uid() lê o `sub` de request.jwt.claims (padrão Supabase;
--     mesma premissa da validação 068).
--
--   SEÇÃO C — VALIDAÇÕES MANUAIS (documentadas no fim do arquivo):
--   fail-safe com falha provocada e TRUNCATE pelo owner (NÃO em
--   produção); teste funcional na UI numa conversation de teste e
--   leitura dos logs (podem ser feitos em produção).
-- ============================================================


-- ============================================================
-- SEÇÃO A — SOMENTE LEITURA (pode executar diretamente)
-- ============================================================

-- A1) Colunas. Esperado: 17 colunas, nesta ordem:
--   id, account_id, conversation_id, event_type, actor_user_id,
--   actor_name, from_agent_id, from_agent_name, to_agent_id,
--   to_agent_name, from_queue_id, from_queue_name, to_queue_id,
--   to_queue_name, from_status, to_status, created_at
SELECT ordinal_position, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'conversation_events'
ORDER BY ordinal_position;

-- A2) Ausência de contact_id e ticket_id. Esperado: 0 | 0
SELECT
  count(*) FILTER (WHERE column_name = 'contact_id') AS contact_id_columns,
  count(*) FILTER (WHERE column_name = 'ticket_id')  AS ticket_id_columns
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'conversation_events';

-- A3) Constraints. Esperado:
--   conversation_events_pkey (p)
--   conversation_events_type_check (c)
--   conversation_events_actor_name_check (c)
--   conversation_events_shape_check (c)
--   2 FKs (f): account_id → accounts ON DELETE CASCADE,
--              conversation_id → conversations ON DELETE CASCADE,
--   ambas condeferrable = false.
SELECT conname, contype, condeferrable, condeferred, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.conversation_events'::regclass
ORDER BY contype, conname;

-- A4) FKs apontam SOMENTE para accounts e conversations (nenhuma para
--     auth.users / profiles / queues / contacts / tickets).
--     Esperado: 2 linhas — accounts, conversations.
SELECT confrelid::regclass AS references_table, count(*) AS fks
FROM pg_constraint
WHERE conrelid = 'public.conversation_events'::regclass AND contype = 'f'
GROUP BY confrelid
ORDER BY 1;

-- A5) Índices. Esperado (além da PK):
--   idx_conversation_events_conversation      (conversation_id, created_at)
--   idx_conversation_events_account_created   (account_id, created_at)
--   idx_conversation_events_one_history_started UNIQUE (conversation_id)
--     WHERE event_type = 'history_started'
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'conversation_events'
ORDER BY indexname;

-- A6) RLS habilitada e owner da tabela. Esperado:
--     rls_enabled = true, table_owner = postgres
--     (conversation_events_capture, SECURITY DEFINER/owner postgres,
--     depende disso para conseguir inserir após o REVOKE ALL).
SELECT relname,
       relrowsecurity AS rls_enabled,
       relforcerowsecurity AS rls_forced,
       pg_get_userbyid(relowner) AS table_owner
FROM pg_class
WHERE oid = 'public.conversation_events'::regclass;

-- A7) Policies. Esperado: UMA policy — conversation_events_select,
--     cmd = SELECT, roles = {authenticated}, USING com EXISTS em
--     conversations. Nenhuma policy de INSERT/UPDATE/DELETE/ALL.
SELECT policyname, cmd, roles, permissive, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'conversation_events';

-- A7b) Nenhuma policy de escrita. Esperado: write_policies = 0
SELECT count(*) AS write_policies
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'conversation_events'
  AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL');

-- A8) Grants. Esperado:
--   anon:          tudo false
--   authenticated: SELECT true; INSERT/UPDATE/DELETE/TRUNCATE false
--   service_role:  SELECT true; INSERT/UPDATE/DELETE/TRUNCATE false
SELECT
  r.role_name,
  has_table_privilege(r.role_name, 'public.conversation_events', 'SELECT')   AS can_select,
  has_table_privilege(r.role_name, 'public.conversation_events', 'INSERT')   AS can_insert,
  has_table_privilege(r.role_name, 'public.conversation_events', 'UPDATE')   AS can_update,
  has_table_privilege(r.role_name, 'public.conversation_events', 'DELETE')   AS can_delete,
  has_table_privilege(r.role_name, 'public.conversation_events', 'TRUNCATE') AS can_truncate
FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role_name);

-- A9) Funções (4 linhas). Esperado:
--   conversation_events_capture           security_definer = true,  owner postgres,
--                                         proconfig = {search_path=public}, has_exception_block = true
--   conversation_events_validate_tenancy  security_definer = true,  owner postgres,
--                                         proconfig = {search_path=public}, has_exception_block = false
--                                         (SEM fail-safe próprio — integridade da tabela)
--   conversation_events_reject_update     security_definer = false, owner postgres, {search_path=public}
--   conversation_events_reject_truncate   security_definer = false, owner postgres, {search_path=public}
--   *_can_execute = false para anon/authenticated/service_role nas 4.
SELECT
  p.proname,
  p.prosecdef AS security_definer,
  pg_get_userbyid(p.proowner) AS owner,
  p.proconfig,
  (p.prosrc ILIKE '%EXCEPTION WHEN OTHERS%') AS has_exception_block,
  has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('service_role',  p.oid, 'EXECUTE') AS service_role_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('conversation_events_capture',
                    'conversation_events_validate_tenancy',
                    'conversation_events_reject_update',
                    'conversation_events_reject_truncate')
ORDER BY p.proname;

-- A10) Triggers. Esperado (tgenabled = 'O' em todas):
--   em conversations:
--     conversation_events_on_insert  AFTER INSERT  FOR EACH ROW
--     conversation_events_on_update  AFTER UPDATE  FOR EACH ROW  WHEN (…)
--       → has_column_list = false (NÃO é UPDATE OF), has_when = true
--   em conversation_events (3 triggers):
--     conversation_events_no_truncate        BEFORE TRUNCATE FOR EACH STATEMENT
--     conversation_events_no_update          BEFORE UPDATE   FOR EACH ROW
--     conversation_events_validate_tenancy   BEFORE INSERT   FOR EACH ROW
--   e NENHUMA trigger de DELETE em conversation_events.
--   Total esperado: 5 linhas (2 em conversations + 3 em conversation_events).
--   tgtype esperado: on_insert=5, on_update=17, validate_tenancy=7,
--   no_update=19, no_truncate=34 (bits ROW=1 BEFORE=2 INSERT=4
--   DELETE=8 UPDATE=16 TRUNCATE=32; sem BEFORE = AFTER).
--   has_column_list: tgattr é int2vector, sempre 1-D — vazio vira um
--   array 1-D com 0 elementos (array_length(…, 1) = 0, NÃO NULL).
--   cardinality() = 0 para qualquer array vazio → detecção correta.
--   Casts explícitos (tgtype::int, tgenabled::text, tgrelid::regclass::text)
--   evitam o erro 42725 (operador ambíguo) com tipos internos.
SELECT
  t.tgrelid::regclass::text AS table_name,
  t.tgname::text AS tgname,
  t.tgtype::int AS tgtype,
  t.tgenabled::text AS tgenabled,
  (cardinality(t.tgattr::int2[]) > 0) AS has_column_list,
  (t.tgqual IS NOT NULL) AS has_when,
  pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
WHERE NOT t.tgisinternal
  AND t.tgname LIKE 'conversation_events_%'
ORDER BY 1, 2;

-- A10b) Nenhuma trigger de DELETE em conversation_events. Esperado: 0
SELECT count(*) AS delete_triggers_on_conversation_events
FROM pg_trigger t
WHERE NOT t.tgisinternal
  AND t.tgrelid = 'public.conversation_events'::regclass
  AND (t.tgtype::int & 8) <> 0;   -- bit TRIGGER_TYPE_DELETE

-- A11) Snapshot inicial. Esperado:
--   history_started_rows = N informado pelo NOTICE da migration
--   ("086 history_started snapshot rows: N") — esse número é FIXO para
--   sempre; distinct_instants = 1 (todos no instante da migration).
--   NÃO compare com count(conversations): conversations criadas depois
--   da migration recebem 'opened', nunca 'history_started'.
SELECT
  count(*)                   AS history_started_rows,
  count(DISTINCT created_at) AS distinct_instants,
  min(created_at)            AS snapshot_instant
FROM public.conversation_events
WHERE event_type = 'history_started';

-- A12) Invariante de origem — vale para sempre: toda conversation tem
--      EXATAMENTE UM evento de origem (history_started se já existia na
--      migration, opened se foi criada depois). Esperado:
--        sem_origem = 0  (um valor > 0 indica 'opened' perdido — o
--                         fail-safe engoliu uma falha; ver logs)
--        com_os_dois = 0
--        origem_duplicada = 0
SELECT
  count(*) FILTER (WHERE o.n_origin = 0)                     AS sem_origem,
  count(*) FILTER (WHERE o.n_hist > 0 AND o.n_opened > 0)    AS com_os_dois,
  count(*) FILTER (WHERE o.n_origin > 1)                     AS origem_duplicada
FROM (
  SELECT
    c.id,
    count(e.id) FILTER (WHERE e.event_type IN ('history_started', 'opened')) AS n_origin,
    count(e.id) FILTER (WHERE e.event_type = 'history_started')              AS n_hist,
    count(e.id) FILTER (WHERE e.event_type = 'opened')                       AS n_opened
  FROM public.conversations c
  LEFT JOIN public.conversation_events e ON e.conversation_id = c.id
  GROUP BY c.id
) o;

-- A13) Nenhum history_started fora do instante do snapshot (a trigger
--      nunca gera history_started). Esperado: 0
SELECT count(*) AS history_started_after_snapshot
FROM public.conversation_events e
WHERE e.event_type = 'history_started'
  AND e.created_at <> (SELECT min(created_at) FROM public.conversation_events
                       WHERE event_type = 'history_started');

-- A14) Coerência de conta: account_id do evento = da conversation.
--      Esperado: 0
SELECT count(*) AS account_mismatch
FROM public.conversation_events e
JOIN public.conversations c ON c.id = e.conversation_id
WHERE c.account_id <> e.account_id;

-- A15) Distribuição (somente contagens; sem dado pessoal).
SELECT event_type, count(*) AS n,
       count(*) FILTER (WHERE actor_user_id IS NULL) AS sistema,
       count(*) FILTER (WHERE actor_user_id IS NOT NULL) AS usuario,
       min(created_at) AS primeiro, max(created_at) AS ultimo
FROM public.conversation_events
GROUP BY event_type
ORDER BY event_type;

-- A16) Informativo (heurística por nome, não recursiva): triggers com
--      possível efeito externo (pg_net / supabase_functions / http) nas
--      tabelas que a Seção B toca diretamente. Mesmo com 0 linhas, a
--      Seção B continua PROIBIDA em produção — só ambiente descartável.
SELECT t.tgrelid::regclass AS table_name, t.tgname, pn.nspname AS function_schema, p.proname
FROM pg_trigger t
JOIN pg_proc p       ON p.oid = t.tgfoid
JOIN pg_namespace pn ON pn.oid = p.pronamespace
WHERE NOT t.tgisinternal
  AND t.tgrelid IN ('auth.users'::regclass, 'public.accounts'::regclass,
                    'public.profiles'::regclass, 'public.contacts'::regclass,
                    'public.conversations'::regclass, 'public.queues'::regclass,
                    'public.notifications'::regclass)
  AND (pn.nspname IN ('net', 'supabase_functions', 'http')
       OR p.prosrc ILIKE '%net.http%'
       OR p.prosrc ILIKE '%http_request%');


-- ============================================================
-- SEÇÃO B — TESTES MUTÁVEIS
--
--   *************************************************************
--   ***  NÃO EXECUTAR EM PRODUÇÃO.                              ***
--   ***  Somente em ambiente descartável (branch de banco /     ***
--   ***  cópia de teste). Ver o cabeçalho deste arquivo.        ***
--   *************************************************************
--
-- No ambiente descartável: copie e execute ESTE BLOCO SOZINHO.
-- BEGIN … ROLLBACK. Somente dados sintéticos. Nenhum COMMIT.
-- ============================================================

BEGIN;

DO $b$
DECLARE
  v_owner   UUID := gen_random_uuid();
  v_x       UUID := gen_random_uuid();
  v_y       UUID := gen_random_uuid();
  v_qa      UUID := gen_random_uuid();
  v_qb      UUID := gen_random_uuid();
  v_contact UUID := gen_random_uuid();
  v_conv    UUID := gen_random_uuid();
  v_account UUID;
  v_account_b UUID;
  v_n       INTEGER;
  v_rows    INTEGER;
  v_types   TEXT[];
  v_sql     TEXT;
  r         RECORD;
  c         RECORD;
BEGIN
  -- ----------------------------------------------------------
  -- B0) Pré-condição de segurança — aborta ANTES de criar qualquer
  --     coisa se houver trigger com efeito externo nas tabelas tocadas.
  -- ----------------------------------------------------------
  SELECT count(*) INTO v_n
  FROM pg_trigger t
  JOIN pg_proc p       ON p.oid = t.tgfoid
  JOIN pg_namespace pn ON pn.oid = p.pronamespace
  WHERE NOT t.tgisinternal
    AND t.tgrelid IN ('auth.users'::regclass, 'public.accounts'::regclass,
                      'public.profiles'::regclass, 'public.contacts'::regclass,
                      'public.conversations'::regclass, 'public.queues'::regclass,
                      'public.notifications'::regclass)
    AND (pn.nspname IN ('net', 'supabase_functions', 'http')
         OR p.prosrc ILIKE '%net.http%'
         OR p.prosrc ILIKE '%http_request%');
  IF v_n > 0 THEN
    RAISE EXCEPTION '086 ABORT B0: % trigger(s) com possível efeito externo — Seção B não executada', v_n;
  END IF;

  -- Sem identidade JWT herdada: tudo abaixo roda como "sistema" até o B12.
  PERFORM set_config('request.jwt.claims', '', true);

  -- ----------------------------------------------------------
  -- Fixtures sintéticas
  -- ----------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     '__086_check__owner@example.invalid', 'x', now(), now(), now(), '{}',
     '{"full_name":"__086_check__ Owner"}'),
    (v_x, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     '__086_check__agent_x@example.invalid', 'x', now(), now(), now(), '{}',
     '{"full_name":"__086_check__ Agent X"}'),
    (v_y, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     '__086_check__agent_y@example.invalid', 'x', now(), now(), now(), '{}',
     '{"full_name":"__086_check__ Agent Y"}');

  -- handle_new_user (017) cria conta + perfil owner para cada usuário.
  SELECT account_id INTO v_account FROM public.profiles WHERE user_id = v_owner;
  IF v_account IS NULL THEN
    RAISE EXCEPTION '086 ABORT: handle_new_user não criou conta/perfil sintético para o owner';
  END IF;

  INSERT INTO public.queues (id, account_id, name, is_active) VALUES
    (v_qa, v_account, '__086_check__ Queue A', true),
    (v_qb, v_account, '__086_check__ Queue B', true);

  INSERT INTO public.contacts (id, user_id, account_id, phone, name)
  VALUES (v_contact, v_owner, v_account, '+5500000086001', '__086_check__ Contact');

  -- Conversation sintética (inserida como "sistema": ator NULL).
  INSERT INTO public.conversations (id, user_id, account_id, contact_id, status, queue_id, assigned_agent_id)
  VALUES (v_conv, v_owner, v_account, v_contact, 'pending', NULL, NULL);

  RAISE NOTICE '086 fixtures prontas (sintéticas): account=%, conversation=%', v_account, v_conv;

  -- ----------------------------------------------------------
  -- B1) opened — e nunca history_started pela trigger
  -- ----------------------------------------------------------
  SELECT count(*) INTO v_n FROM public.conversation_events WHERE conversation_id = v_conv;
  SELECT * INTO r FROM public.conversation_events WHERE conversation_id = v_conv
    ORDER BY created_at DESC, id DESC LIMIT 1;
  IF NOT (v_n = 1 AND r.event_type = 'opened' AND r.actor_user_id IS NULL
          AND r.from_status IS NULL AND r.from_agent_id IS NULL AND r.from_queue_id IS NULL
          AND r.to_status = 'pending') THEN
    RAISE EXCEPTION '086 FAIL B1 opened: n=% type=%', v_n, r.event_type;
  END IF;
  RAISE NOTICE '086 PASS B1 INSERT gera exatamente 1 opened (ator NULL = sistema)';

  -- ----------------------------------------------------------
  -- B2) Ruído — nenhum evento
  -- ----------------------------------------------------------
  UPDATE public.conversations SET status = 'in_progress' WHERE id = v_conv;
  UPDATE public.conversations SET status = 'pending' WHERE id = v_conv;
  UPDATE public.conversations SET status = 'waiting_customer' WHERE id = v_conv;
  UPDATE public.conversations SET status = 'pending' WHERE id = v_conv;
  UPDATE public.conversations
     SET last_message_at = now(), last_message_text = '__086_check__ msg', unread_count = unread_count + 1
   WHERE id = v_conv;
  -- Mesmo padrão da RPC de inbound: colunas no SET, valores iguais.
  UPDATE public.conversations
     SET status = status, queue_id = queue_id, assigned_agent_id = assigned_agent_id
   WHERE id = v_conv;
  SELECT count(*) INTO v_n FROM public.conversation_events WHERE conversation_id = v_conv;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '086 FAIL B2 ruído gerou eventos: n=%', v_n;
  END IF;
  RAISE NOTICE '086 PASS B2 pending↔in_progress↔waiting_customer, mensagens e SET sem mudança: 0 eventos';

  -- ----------------------------------------------------------
  -- B3) assigned junto com pending → in_progress (1 evento)
  -- ----------------------------------------------------------
  UPDATE public.conversations SET assigned_agent_id = v_x, status = 'in_progress' WHERE id = v_conv;
  SELECT count(*) INTO v_n FROM public.conversation_events WHERE conversation_id = v_conv;
  SELECT * INTO r FROM public.conversation_events WHERE conversation_id = v_conv
    ORDER BY created_at DESC, id DESC LIMIT 1;
  IF NOT (v_n = 2 AND r.event_type = 'assigned' AND r.from_agent_id IS NULL AND r.to_agent_id = v_x
          AND r.to_agent_name = '__086_check__ Agent X'
          AND r.from_status = 'pending' AND r.to_status = 'in_progress') THEN
    RAISE EXCEPTION '086 FAIL B3 assigned: n=% type=%', v_n, r.event_type;
  END IF;
  RAISE NOTICE '086 PASS B3 assigned (com flip de status no mesmo UPDATE, 1 evento, nome congelado)';

  -- ----------------------------------------------------------
  -- B4) reassigned X → Y
  -- ----------------------------------------------------------
  UPDATE public.conversations SET assigned_agent_id = v_y WHERE id = v_conv;
  SELECT count(*) INTO v_n FROM public.conversation_events WHERE conversation_id = v_conv;
  SELECT * INTO r FROM public.conversation_events WHERE conversation_id = v_conv
    ORDER BY created_at DESC, id DESC LIMIT 1;
  IF NOT (v_n = 3 AND r.event_type = 'reassigned' AND r.from_agent_id = v_x AND r.to_agent_id = v_y
          AND r.from_agent_name = '__086_check__ Agent X' AND r.to_agent_name = '__086_check__ Agent Y') THEN
    RAISE EXCEPTION '086 FAIL B4 reassigned: n=% type=%', v_n, r.event_type;
  END IF;
  RAISE NOTICE '086 PASS B4 reassigned';

  -- ----------------------------------------------------------
  -- B5) queue_changed NULL → A, responsável inalterado
  -- ----------------------------------------------------------
  UPDATE public.conversations SET queue_id = v_qa WHERE id = v_conv;
  SELECT count(*) INTO v_n FROM public.conversation_events WHERE conversation_id = v_conv;
  SELECT * INTO r FROM public.conversation_events WHERE conversation_id = v_conv
    ORDER BY created_at DESC, id DESC LIMIT 1;
  IF NOT (v_n = 4 AND r.event_type = 'queue_changed' AND r.from_queue_id IS NULL AND r.to_queue_id = v_qa
          AND r.to_queue_name = '__086_check__ Queue A'
          AND r.from_agent_id = v_y AND r.to_agent_id = v_y) THEN
    RAISE EXCEPTION '086 FAIL B5 queue_changed: n=% type=%', v_n, r.event_type;
  END IF;
  RAISE NOTICE '086 PASS B5 queue_changed (responsável preservado no evento)';

  -- ----------------------------------------------------------
  -- B6) Transferência de setor: fila A → B + responsável Y → NULL
  --     no MESMO UPDATE → exatamente 1 queue_changed
  -- ----------------------------------------------------------
  UPDATE public.conversations SET queue_id = v_qb, assigned_agent_id = NULL WHERE id = v_conv;
  SELECT count(*) INTO v_n FROM public.conversation_events WHERE conversation_id = v_conv;
  SELECT * INTO r FROM public.conversation_events WHERE conversation_id = v_conv
    ORDER BY created_at DESC, id DESC LIMIT 1;
  IF NOT (v_n = 5 AND r.event_type = 'queue_changed'
          AND r.from_queue_name = '__086_check__ Queue A' AND r.to_queue_name = '__086_check__ Queue B'
          AND r.from_agent_id = v_y AND r.to_agent_id IS NULL) THEN
    RAISE EXCEPTION '086 FAIL B6 transferência de setor: n=% type=%', v_n, r.event_type;
  END IF;
  RAISE NOTICE '086 PASS B6 fila+desatribuição simultâneas = 1 queue_changed (sem unassigned redundante)';

  -- ----------------------------------------------------------
  -- B7) assigned NULL → X  /  B8) unassigned X → NULL
  -- ----------------------------------------------------------
  UPDATE public.conversations SET assigned_agent_id = v_x WHERE id = v_conv;
  UPDATE public.conversations SET assigned_agent_id = NULL WHERE id = v_conv;
  SELECT count(*) INTO v_n FROM public.conversation_events WHERE conversation_id = v_conv;
  SELECT * INTO r FROM public.conversation_events WHERE conversation_id = v_conv
    ORDER BY created_at DESC, id DESC LIMIT 1;
  IF NOT (v_n = 7 AND r.event_type = 'unassigned' AND r.from_agent_id = v_x AND r.to_agent_id IS NULL
          AND r.from_queue_id = v_qb AND r.to_queue_id = v_qb) THEN
    RAISE EXCEPTION '086 FAIL B7/B8 assigned+unassigned: n=% type=%', v_n, r.event_type;
  END IF;
  RAISE NOTICE '086 PASS B7/B8 assigned e unassigned';

  -- ----------------------------------------------------------
  -- B9) closed com desatribuição simultânea → exatamente 1 closed
  -- ----------------------------------------------------------
  UPDATE public.conversations SET assigned_agent_id = v_x WHERE id = v_conv;              -- assigned
  UPDATE public.conversations SET status = 'closed', assigned_agent_id = NULL WHERE id = v_conv;
  SELECT count(*) INTO v_n FROM public.conversation_events WHERE conversation_id = v_conv;
  SELECT * INTO r FROM public.conversation_events WHERE conversation_id = v_conv
    ORDER BY created_at DESC, id DESC LIMIT 1;
  IF NOT (v_n = 9 AND r.event_type = 'closed' AND r.from_status = 'in_progress' AND r.to_status = 'closed'
          AND r.from_agent_id = v_x AND r.to_agent_id IS NULL) THEN
    RAISE EXCEPTION '086 FAIL B9 closed: n=% type=%', v_n, r.event_type;
  END IF;
  RAISE NOTICE '086 PASS B9 closed tem precedência (1 evento, guarda X → NULL)';

  -- ----------------------------------------------------------
  -- B10) closed → finalized (mesmo episódio)
  -- ----------------------------------------------------------
  UPDATE public.conversations SET status = 'finalized' WHERE id = v_conv;
  SELECT count(*) INTO v_n FROM public.conversation_events WHERE conversation_id = v_conv;
  SELECT * INTO r FROM public.conversation_events WHERE conversation_id = v_conv
    ORDER BY created_at DESC, id DESC LIMIT 1;
  IF NOT (v_n = 10 AND r.event_type = 'finalized' AND r.from_status = 'closed' AND r.to_status = 'finalized') THEN
    RAISE EXCEPTION '086 FAIL B10 finalized: n=% type=%', v_n, r.event_type;
  END IF;
  RAISE NOTICE '086 PASS B10 closed → finalized = finalized com from_status closed';

  -- ----------------------------------------------------------
  -- B11) Retorno do cliente: finalized → pending + X → NULL + B → NULL
  --      no MESMO UPDATE → exatamente 1 reopened
  -- ----------------------------------------------------------
  UPDATE public.conversations SET assigned_agent_id = v_x WHERE id = v_conv;              -- assigned (status finalized inalterado)
  UPDATE public.conversations
     SET status = 'pending', assigned_agent_id = NULL, queue_id = NULL
   WHERE id = v_conv;
  SELECT count(*) INTO v_n FROM public.conversation_events WHERE conversation_id = v_conv;
  SELECT * INTO r FROM public.conversation_events WHERE conversation_id = v_conv
    ORDER BY created_at DESC, id DESC LIMIT 1;
  IF NOT (v_n = 12 AND r.event_type = 'reopened'
          AND r.from_status = 'finalized' AND r.to_status = 'pending'
          AND r.from_agent_id = v_x AND r.from_agent_name = '__086_check__ Agent X' AND r.to_agent_id IS NULL
          AND r.from_queue_id = v_qb AND r.from_queue_name = '__086_check__ Queue B' AND r.to_queue_id IS NULL
          AND r.actor_user_id IS NULL) THEN
    RAISE EXCEPTION '086 FAIL B11 reopened: n=% type=%', v_n, r.event_type;
  END IF;
  RAISE NOTICE '086 PASS B11 reopened absorve desatribuição e limpeza de fila (sem unassigned/queue_changed)';

  -- ----------------------------------------------------------
  -- B12) Ator: JWT simulado do owner + ROLE authenticated
  -- ----------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.conversations SET assigned_agent_id = v_y WHERE id = v_conv;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  -- RLS (regra A): o owner enxerga a conversation → enxerga os eventos.
  SELECT count(*) INTO v_n FROM public.conversation_events WHERE conversation_id = v_conv;
  EXECUTE 'RESET ROLE';
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '086 FAIL B12 UPDATE como authenticated não afetou a conversation sintética (rows=%)', v_rows;
  END IF;
  IF v_n <> 13 THEN
    RAISE EXCEPTION '086 FAIL B12 RLS: owner deveria ver 13 eventos, viu %', v_n;
  END IF;
  SELECT * INTO r FROM public.conversation_events WHERE conversation_id = v_conv
    ORDER BY created_at DESC, id DESC LIMIT 1;
  IF NOT (r.event_type = 'assigned' AND r.actor_user_id = v_owner AND r.actor_name = '__086_check__ Owner') THEN
    RAISE EXCEPTION '086 FAIL B12 ator: type=% actor=%', r.event_type, r.actor_user_id;
  END IF;
  RAISE NOTICE '086 PASS B12 auth.uid() = sub do JWT (actor + actor_name); owner vê os 13 eventos';

  -- B12b) RLS: usuário de OUTRA conta (Agent X é owner da própria
  --       conta sintética, não é membro da conta do owner) vê 0.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_x, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM public.conversation_events WHERE conversation_id = v_conv;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  IF v_n <> 0 THEN
    RAISE EXCEPTION '086 FAIL B12b RLS cross-account: viu % eventos', v_n;
  END IF;
  RAISE NOTICE '086 PASS B12b RLS: outra conta vê 0 eventos';

  -- ----------------------------------------------------------
  -- B13) Sequência completa: exatamente 1 evento por UPDATE relevante
  -- ----------------------------------------------------------
  SELECT array_agg(event_type ORDER BY created_at, id) INTO v_types
  FROM public.conversation_events WHERE conversation_id = v_conv;
  IF v_types IS DISTINCT FROM ARRAY[
       'opened', 'assigned', 'reassigned', 'queue_changed', 'queue_changed',
       'assigned', 'unassigned', 'assigned', 'closed', 'finalized',
       'assigned', 'reopened', 'assigned'] THEN
    RAISE EXCEPTION '086 FAIL B13 sequência: %', v_types;
  END IF;
  IF EXISTS (SELECT 1 FROM public.conversation_events
             WHERE conversation_id = v_conv AND event_type = 'history_started') THEN
    RAISE EXCEPTION '086 FAIL B13 a trigger gerou history_started';
  END IF;
  RAISE NOTICE '086 PASS B13 sequência exata (13 eventos) e nenhum history_started pela trigger';

  -- ----------------------------------------------------------
  -- B14) Append-only — authenticated e service_role sem escrita
  --      (TRUNCATE não é tentado: ver Seção C)
  -- ----------------------------------------------------------
  FOR c IN SELECT * FROM (VALUES ('authenticated'), ('service_role')) AS t(role_name) LOOP
    IF c.role_name = 'authenticated' THEN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    ELSE
      PERFORM set_config('request.jwt.claims', '', true);
    END IF;
    EXECUTE format('SET LOCAL ROLE %I', c.role_name);

    BEGIN
      INSERT INTO public.conversation_events (account_id, conversation_id, event_type, to_status)
      VALUES (v_account, v_conv, 'opened', 'pending');
      RAISE EXCEPTION '086 FAIL B14 % conseguiu INSERT', c.role_name;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    BEGIN
      UPDATE public.conversation_events SET to_status = 'x' WHERE conversation_id = v_conv;
      RAISE EXCEPTION '086 FAIL B14 % conseguiu UPDATE', c.role_name;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    BEGIN
      DELETE FROM public.conversation_events WHERE conversation_id = v_conv;
      RAISE EXCEPTION '086 FAIL B14 % conseguiu DELETE', c.role_name;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    EXECUTE 'RESET ROLE';
    RAISE NOTICE '086 PASS B14 % sem INSERT/UPDATE/DELETE em conversation_events', c.role_name;
  END LOOP;
  PERFORM set_config('request.jwt.claims', '', true);

  -- B14b) UPDATE bloqueado pela trigger mesmo para o owner (postgres).
  BEGIN
    UPDATE public.conversation_events SET to_status = 'x' WHERE conversation_id = v_conv;
    RAISE EXCEPTION '086 FAIL B14b owner conseguiu UPDATE';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN
      RAISE EXCEPTION '086 FAIL B14b erro inesperado: %', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '086 PASS B14b UPDATE rejeitado pela trigger também para o owner';

  -- ----------------------------------------------------------
  -- B15) Matriz do CHECK (como owner, em linhas sintéticas).
  --      Placeholders: :acc :conv :x :y :qa :qb
  -- ----------------------------------------------------------
  -- Inválidos — todos devem falhar com check_violation (23514).
  FOR c IN SELECT * FROM (VALUES
    ('tipo inexistente',                 '''bogus'', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ''pending'''),
    ('history_started com ator',         '''history_started'', :x, NULL, NULL, NULL, NULL, NULL, NULL, ''pending'''),
    ('history_started com from_status',  '''history_started'', NULL, NULL, NULL, NULL, NULL, NULL, ''pending'', ''pending'''),
    ('opened com from_agent',            '''opened'', NULL, NULL, :x, NULL, NULL, NULL, NULL, ''pending'''),
    ('reopened pending→in_progress',     '''reopened'', NULL, NULL, NULL, NULL, NULL, NULL, ''pending'', ''in_progress'''),
    ('reopened closed→finalized',        '''reopened'', NULL, NULL, NULL, NULL, NULL, NULL, ''closed'', ''finalized'''),
    ('closed closed→closed',             '''closed'', NULL, NULL, NULL, NULL, NULL, NULL, ''closed'', ''closed'''),
    ('finalized para closed',            '''finalized'', NULL, NULL, NULL, NULL, NULL, NULL, ''in_progress'', ''closed'''),
    ('assigned X→Y',                     '''assigned'', NULL, NULL, :x, :y, NULL, NULL, ''pending'', ''pending'''),
    ('assigned cruzando reabertura',     '''assigned'', NULL, NULL, NULL, :x, NULL, NULL, ''closed'', ''pending'''),
    ('assigned sem from_status',         '''assigned'', NULL, NULL, NULL, :x, NULL, NULL, NULL, ''pending'''),
    ('reassigned X→X',                   '''reassigned'', NULL, NULL, :x, :x, NULL, NULL, ''pending'', ''pending'''),
    ('unassigned NULL→NULL',             '''unassigned'', NULL, NULL, NULL, NULL, NULL, NULL, ''pending'', ''pending'''),
    ('unassigned cruzando fechamento',   '''unassigned'', NULL, NULL, :x, NULL, NULL, NULL, ''in_progress'', ''closed'''),
    ('queue_changed A→A',                '''queue_changed'', NULL, NULL, NULL, NULL, :qa, :qa, ''pending'', ''pending'''),
    ('queue_changed A→B com X→Y',        '''queue_changed'', NULL, NULL, :x, :y, :qa, :qb, ''pending'', ''pending'''),
    ('actor_name sem actor_user_id',     '''assigned'', NULL, ''Nome'', NULL, :x, NULL, NULL, ''pending'', ''pending''')
  ) AS t(label, tail) LOOP
    v_sql := 'INSERT INTO public.conversation_events (account_id, conversation_id, event_type, '
          || 'actor_user_id, actor_name, from_agent_id, to_agent_id, from_queue_id, to_queue_id, '
          || 'from_status, to_status) VALUES (:acc, :conv, ' || c.tail || ')';
    v_sql := replace(v_sql, ':acc',  quote_literal(v_account::text));
    v_sql := replace(v_sql, ':conv', quote_literal(v_conv::text));
    v_sql := replace(v_sql, ':x',    quote_literal(v_x::text));
    v_sql := replace(v_sql, ':y',    quote_literal(v_y::text));
    v_sql := replace(v_sql, ':qa',   quote_literal(v_qa::text));
    v_sql := replace(v_sql, ':qb',   quote_literal(v_qb::text));
    BEGIN
      EXECUTE v_sql;
      RAISE EXCEPTION '086 FAIL B15 CHECK aceitou caso inválido: %', c.label;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  RAISE NOTICE '086 PASS B15a CHECK rejeita os 17 casos inválidos';

  -- Válidos (mudanças simultâneas legítimas) — devem ser aceitos.
  FOR c IN SELECT * FROM (VALUES
    ('queue_changed A→B com X→NULL',     '''queue_changed'', NULL, NULL, :x, NULL, :qa, :qb, ''pending'', ''pending'''),
    ('closed com X→NULL e A→NULL',       '''closed'', NULL, NULL, :x, NULL, :qa, NULL, ''in_progress'', ''closed'''),
    ('reopened com X→NULL e B→NULL',     '''reopened'', NULL, NULL, :x, NULL, :qb, NULL, ''finalized'', ''pending'''),
    ('assigned com pending→in_progress', '''assigned'', NULL, NULL, NULL, :x, NULL, NULL, ''pending'', ''in_progress'''),
    ('finalized vindo de closed',        '''finalized'', NULL, NULL, NULL, NULL, NULL, NULL, ''closed'', ''finalized'''),
    ('assigned com conversa encerrada',  '''assigned'', NULL, NULL, NULL, :x, NULL, NULL, ''finalized'', ''finalized'''),
    ('history_started válido',           '''history_started'', NULL, NULL, NULL, :x, NULL, :qa, NULL, ''in_progress''')
  ) AS t(label, tail) LOOP
    v_sql := 'INSERT INTO public.conversation_events (account_id, conversation_id, event_type, '
          || 'actor_user_id, actor_name, from_agent_id, to_agent_id, from_queue_id, to_queue_id, '
          || 'from_status, to_status) VALUES (:acc, :conv, ' || c.tail || ')';
    v_sql := replace(v_sql, ':acc',  quote_literal(v_account::text));
    v_sql := replace(v_sql, ':conv', quote_literal(v_conv::text));
    v_sql := replace(v_sql, ':x',    quote_literal(v_x::text));
    v_sql := replace(v_sql, ':y',    quote_literal(v_y::text));
    v_sql := replace(v_sql, ':qa',   quote_literal(v_qa::text));
    v_sql := replace(v_sql, ':qb',   quote_literal(v_qb::text));
    BEGIN
      EXECUTE v_sql;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION '086 FAIL B15 CHECK rejeitou caso válido "%": % (%)', c.label, SQLERRM, SQLSTATE;
    END;
  END LOOP;
  RAISE NOTICE '086 PASS B15b CHECK aceita os 7 casos válidos (mudanças simultâneas)';

  -- Segundo history_started para a mesma conversation → unique_violation.
  BEGIN
    INSERT INTO public.conversation_events (account_id, conversation_id, event_type, to_status)
    VALUES (v_account, v_conv, 'history_started', 'pending');
    RAISE EXCEPTION '086 FAIL B15c segundo history_started aceito';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE '086 PASS B15c no máximo 1 history_started por conversation';

  -- ----------------------------------------------------------
  -- B15d) Tenancy estrutural (BEFORE INSERT), como owner:
  --       conversation da conta A + account_id da conta B → rejeitado;
  --       conversation inexistente → rejeitado; A/A coerente → aceito.
  --       Conta B = conta sintética que o handle_new_user criou para o
  --       Agent X (nenhum dado real).
  -- ----------------------------------------------------------
  SELECT account_id INTO v_account_b FROM public.profiles WHERE user_id = v_x;
  IF v_account_b IS NULL OR v_account_b = v_account THEN
    RAISE EXCEPTION '086 ABORT B15d: conta sintética B indisponível';
  END IF;

  BEGIN
    INSERT INTO public.conversation_events (account_id, conversation_id, event_type, from_status, to_status, from_agent_id, to_agent_id)
    VALUES (v_account_b, v_conv, 'assigned', 'pending', 'pending', NULL, v_x);
    RAISE EXCEPTION '086 FAIL B15d evento com account B numa conversation da account A foi aceito';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%must match the conversation account%' THEN
      RAISE EXCEPTION '086 FAIL B15d erro inesperado: %', SQLERRM;
    END IF;
  END;

  BEGIN
    INSERT INTO public.conversation_events (account_id, conversation_id, event_type, to_status)
    VALUES (v_account, gen_random_uuid(), 'opened', 'pending');
    RAISE EXCEPTION '086 FAIL B15d evento para conversation inexistente foi aceito';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.conversation_events (account_id, conversation_id, event_type, from_status, to_status, from_agent_id, to_agent_id)
    VALUES (v_account, v_conv, 'assigned', 'pending', 'pending', NULL, v_x);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION '086 FAIL B15d INSERT coerente A/A rejeitado: % (%)', SQLERRM, SQLSTATE;
  END;
  RAISE NOTICE '086 PASS B15d tenancy: A/B rejeitado, conversation inexistente rejeitada, A/A aceito';

  -- ----------------------------------------------------------
  -- B16) CASCADE: service_role apaga a conversation SINTÉTICA → os
  --      eventos dela somem (REVOKE DELETE não quebra o cascade, que
  --      roda como owner da tabela filha).
  -- ----------------------------------------------------------
  EXECUTE 'SET LOCAL ROLE service_role';
  DELETE FROM public.conversations WHERE id = v_conv;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  SELECT count(*) INTO v_n FROM public.conversation_events WHERE conversation_id = v_conv;
  IF NOT (v_rows = 1 AND v_n = 0) THEN
    RAISE EXCEPTION '086 FAIL B16 cascade: rows=% eventos_restantes=%', v_rows, v_n;
  END IF;
  RAISE NOTICE '086 PASS B16 DELETE da conversation sintética apagou os eventos em cascata';

  RAISE NOTICE '086 ==== TODOS OS TESTES DA SEÇÃO B PASSARAM (ROLLBACK a seguir) ====';
END
$b$;

ROLLBACK;

-- Conferência pós-ROLLBACK (somente leitura). Esperado: 0 | 0
SELECT
  (SELECT count(*) FROM auth.users WHERE email LIKE '\_\_086\_check\_\_%') AS synthetic_users_left,
  (SELECT count(*) FROM public.queues WHERE name LIKE '\_\_086\_check\_\_%') AS synthetic_queues_left;


-- ============================================================
-- SEÇÃO C — VALIDAÇÕES MANUAIS (NÃO automatizadas, por segurança)
-- ============================================================
--
-- C1) Fail-safe com falha provocada — NÃO executar em produção.
--     Provocar uma falha exigiria alterar um objeto de produção (ex.:
--     ADD CONSTRAINT … CHECK (false) NOT VALID em conversation_events),
--     o que toma lock exclusivo da tabela e bloquearia a captura de
--     eventos reais durante o teste. Evidência disponível sem isso:
--       - A9: has_exception_block = true na função de captura;
--       - A12: sem_origem = 0 (nenhum 'opened' perdido).
--     Em um ambiente descartável (nunca produção): dentro de
--     BEGIN … ROLLBACK, adicionar a constraint acima, fazer um UPDATE
--     relevante numa conversation sintética e confirmar que o UPDATE
--     tem sucesso e o log mostra
--     'conversation_events_capture_failed op=UPDATE sqlstate=23514'.
--     O mesmo caminho vale para uma rejeição da trigger de tenancy
--     (conversation_events_validate_tenancy) dentro da captura: o INSERT
--     do evento falha, o EXCEPTION da captura absorve e conversations
--     segue. Não é provocável de forma isolada — a captura sempre grava
--     NEW.account_id da própria linha — por isso a tenancy é testada por
--     INSERT manual no B15d (ambiente descartável).
--
-- C2) TRUNCATE pelo owner — NÃO executar em produção.
--     Mesmo bloqueado pela trigger, TRUNCATE adquire ACCESS EXCLUSIVE
--     na tabela antes de disparar a trigger e o manteria até o
--     ROLLBACK, travando a captura real. Evidência: A8 (can_truncate =
--     false para os papéis da aplicação) e A10 (trigger
--     conversation_events_no_truncate BEFORE TRUNCATE FOR EACH
--     STATEMENT, tgenabled = 'O').
--
-- C3) Teste funcional na UI, numa conversation de TESTE (nunca de
--     cliente real), com um usuário real logado:
--       atribuir → transferir para outro atendente → mudar de fila
--       (via Flow/RPC) → encerrar → enviar mensagem do WhatsApp de
--       teste (retorno) → assumir de novo → finalizar.
--     Depois, conferir somente essa conversation:
--       SELECT event_type, actor_name, from_agent_name, to_agent_name,
--              from_queue_name, to_queue_name, from_status, to_status, created_at
--       FROM public.conversation_events
--       WHERE conversation_id = '<id da conversation de teste>'
--       ORDER BY created_at, id;
--     Esperado: exatamente 1 evento por passo; ator = usuário logado
--     nas ações do Inbox; ator NULL no retorno (webhook) e em Flow.
--
-- C4) Logs: no Supabase (Logs → Postgres), buscar
--     'conversation_events_capture_failed'. Esperado: nenhuma
--     ocorrência. Qualquer ocorrência indica evento não gravado (a
--     operação principal NÃO foi afetada); cruzar com A12.
--
-- C5) Rollback da 086 (somente se decidido):
--     nível 1 (recomendado — para a captura, preserva o histórico):
--       DROP TRIGGER conversation_events_on_insert ON public.conversations;
--       DROP TRIGGER conversation_events_on_update ON public.conversations;
--     nível 2 (remove as funções; exige nível 1 antes):
--       DROP TRIGGER conversation_events_no_update   ON public.conversation_events;
--       DROP TRIGGER conversation_events_no_truncate ON public.conversation_events;
--       DROP FUNCTION public.conversation_events_capture();
--       DROP FUNCTION public.conversation_events_reject_update();
--       DROP FUNCTION public.conversation_events_reject_truncate();
--     DROP TABLE public.conversation_events DESTRÓI o histórico — só
--     com decisão explícita.
-- ============================================================
