-- ============================================================
-- mu2_account_members_fks_check.sql
--
-- Verificação da migration 081_account_members_membership_fks (MU-2).
--
--   SEÇÃO 1 — PRODUÇÃO / SOMENTE LEITURA. Selecione até o marcador
--             "FIM DA SEÇÃO 1". Compare os [SNAPSHOT] com o preflight.
--   SEÇÃO 2 — STAGING APENAS. BEGIN/ROLLBACK, dados sintéticos
--             '__mu2_check__'. NUNCA EXECUTAR EM PRODUÇÃO.
-- ============================================================

-- ============================================================
-- SEÇÃO 1 — PRODUÇÃO / SOMENTE LEITURA
-- ============================================================

-- 1-4. Exatamente 3 FKs apontando para account_members, colunas certas,
-- ON DELETE CASCADE, ON UPDATE NO ACTION, não deferrable, validadas
SELECT c.conrelid::regclass AS source_table, c.conname,
       c.confdeltype AS on_delete, c.confupdtype AS on_update,
       c.condeferrable, c.convalidated,
       pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.contype = 'f' AND c.confrelid = 'public.account_members'::regclass
ORDER BY 1;
-- Esperado: 3 linhas, todas c / a / false / true:
--   internal_team_members     internal_team_members_user_id_account_id_fkey
--   queue_members             queue_members_user_id_account_id_fkey
--   user_permission_overrides user_permission_overrides_user_id_account_id_fkey
-- definition: FOREIGN KEY (user_id, account_id) REFERENCES
--   account_members(user_id, account_id) ON DELETE CASCADE

-- 5/6. FKs para profiles: só deals continua; nenhuma das 3 ficou
SELECT c.conrelid::regclass AS source_table, c.conname,
       c.confdeltype AS on_delete, c.confupdtype AS on_update,
       pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.contype = 'f' AND c.confrelid = 'public.profiles'::regclass
ORDER BY 1, 2;
-- Esperado: 1 linha — deals / deals_assigned_to_fkey /
-- FOREIGN KEY (assigned_to) REFERENCES profiles(id) ON DELETE SET NULL
-- (idêntica ao preflight).

-- As demais FKs das 3 tabelas (queue/team/accounts/auth.users) intactas
SELECT c.conrelid::regclass AS source_table, c.conname, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.contype = 'f'
  AND c.conrelid IN ('public.queue_members'::regclass, 'public.internal_team_members'::regclass,
                     'public.user_permission_overrides'::regclass)
ORDER BY 1, 2;
-- Esperado: além das 3 novas, as mesmas FKs de antes (account_id →
-- accounts, user_id → auth.users, (queue_id, account_id) → queues,
-- (team_id, account_id) → internal_teams, created_by_user_id → auth.users).

-- 7. Nenhum órfão
SELECT
  (SELECT count(*) FROM public.queue_members x
    WHERE NOT EXISTS (SELECT 1 FROM public.account_members m
                       WHERE m.user_id = x.user_id AND m.account_id = x.account_id)) AS queue_members_orphans,
  (SELECT count(*) FROM public.internal_team_members x
    WHERE NOT EXISTS (SELECT 1 FROM public.account_members m
                       WHERE m.user_id = x.user_id AND m.account_id = x.account_id)) AS internal_team_members_orphans,
  (SELECT count(*) FROM public.user_permission_overrides x
    WHERE NOT EXISTS (SELECT 1 FROM public.account_members m
                       WHERE m.user_id = x.user_id AND m.account_id = x.account_id)) AS user_permission_overrides_orphans;
-- Esperado: 0 / 0 / 0.

-- 8/9. Nenhuma linha perdida — contagens  [comparar com SNAPSHOT 8]
SELECT
  (SELECT count(*) FROM public.queue_members)             AS queue_members,
  (SELECT count(*) FROM public.internal_team_members)     AS internal_team_members,
  (SELECT count(*) FROM public.user_permission_overrides) AS user_permission_overrides,
  (SELECT count(*) FROM public.queues WHERE primary_agent_id IS NOT NULL) AS queues_with_primary_agent,
  (SELECT count(*) FROM public.deals WHERE assigned_to IS NOT NULL)       AS deals_assigned;
-- Esperado: IDÊNTICO ao preflight (a 081 não escreve dados).

-- 10/11. account_members e profiles intactos; MU-1 continua 1:1
--        [comparar com SNAPSHOT 3 e 14]
SELECT
  (SELECT count(*) FROM public.profiles)        AS profiles,
  (SELECT count(*) FROM public.account_members) AS memberships,
  (SELECT count(*) FROM public.profiles p
    WHERE NOT EXISTS (SELECT 1 FROM public.account_members m
                       WHERE m.user_id = p.user_id AND m.account_id = p.account_id)) AS profiles_without_membership,
  (SELECT count(*) FROM public.account_members m
    WHERE NOT EXISTS (SELECT 1 FROM public.profiles p
                       WHERE p.user_id = m.user_id AND p.account_id = m.account_id)) AS memberships_without_profile;
-- Esperado: 21 / 21 / 0 / 0 (ou os valores do preflight).

SELECT
  (SELECT md5(string_agg(user_id::text || ':' || account_id::text || ':' || account_role::text || ':' || is_active::text,
                         ',' ORDER BY user_id)) FROM public.profiles)           AS profiles_membership_hash,
  (SELECT md5(string_agg(user_id::text || ':' || account_id::text || ':' || role::text || ':' || is_active::text,
                         ',' ORDER BY user_id, account_id)) FROM public.account_members) AS account_members_hash,
  (SELECT md5(string_agg(id::text, ',' ORDER BY id)) FROM public.queue_members)              AS queue_members_ids_hash,
  (SELECT md5(string_agg(id::text, ',' ORDER BY id)) FROM public.internal_team_members)      AS internal_team_members_ids_hash,
  (SELECT md5(string_agg(id::text, ',' ORDER BY id)) FROM public.user_permission_overrides)  AS user_permission_overrides_ids_hash,
  (SELECT md5(string_agg(id::text || ':' || coalesce(primary_agent_id::text, ''), ',' ORDER BY id))
     FROM public.queues)                                                         AS queues_primary_agent_hash,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.account_members_sync_from_profile()'::regprocedure) AS sync_fn_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.remove_account_member(uuid)'::regprocedure)        AS remove_account_member_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.account_has_any_data(uuid)'::regprocedure)         AS account_has_any_data_md5,
  (SELECT md5(prosrc) FROM pg_proc
    WHERE oid = 'public.is_account_member(uuid, public.account_role_enum)'::regprocedure)                  AS is_account_member_md5;
-- Esperado: TODOS idênticos ao SNAPSHOT 14 do preflight. Divergência só
-- aceitável por uso legítimo do sistema entre preflight e check.

-- account_members: estrutura e constraints intactas
SELECT conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.account_members'::regclass
ORDER BY contype, conname;
-- Esperado: igual à MU-1 (pkey, UNIQUE (user_id, account_id), 3 FKs).

-- 12. Trigger temporário presente e ativo
SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgrelid = 'public.profiles'::regclass AND tgname = 'sync_account_members';
-- Esperado: 1 linha, tgenabled = O.

-- Triggers relevantes preservados  [comparar com SNAPSHOT 12]
SELECT tgrelid::regclass AS tbl, tgname, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE NOT tgisinternal
  AND tgrelid IN ('public.queue_members'::regclass, 'public.internal_team_members'::regclass,
                  'public.user_permission_overrides'::regclass, 'public.account_members'::regclass,
                  'public.profiles'::regclass, 'public.queues'::regclass)
ORDER BY 1, 2;
-- Esperado: IDÊNTICO ao preflight.

-- 13. RLS/policies intactas  [comparar com SNAPSHOT 13]
SELECT
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS policies_total,
  (SELECT md5(string_agg(tablename || '.' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''),
                         ',' ORDER BY tablename, policyname))
     FROM pg_policies WHERE schemaname = 'public')                AS policies_md5,
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND coalesce(qual, '') || coalesce(with_check, '') ILIKE '%account_members%') AS policies_referencing_account_members;
-- Esperado: policies_total e policies_md5 idênticos ao preflight;
-- policies_referencing_account_members = 0 (runtime ainda não lê a tabela).

-- ============================================================
-- FIM DA SEÇÃO 1
-- ============================================================


-- ============================================================
-- SEÇÃO 2 — STAGING APENAS. NUNCA EXECUTAR EM PRODUÇÃO.
--
-- BEGIN/ROLLBACK. Fixtures pelo caminho real: auth.users →
-- handle_new_user (017) → sync_account_members (079); agents entram na
-- account A por create_account_member (depende da 080).
--
--   v_a    — owner da account A
--   v_ag   — agent em A (vai ser removido por remove_account_member)
--   v_ag2  — agent em A (ON UPDATE NO ACTION + DELETE direto de membership)
--   v_b    — owner da account B (controle cross-account)
-- ============================================================

BEGIN;

DO $outer$
DECLARE
  v_a      UUID := gen_random_uuid();
  v_ag     UUID := gen_random_uuid();
  v_ag2    UUID := gen_random_uuid();
  v_b      UUID := gen_random_uuid();
  v_acc_a  UUID;
  v_acc_b  UUID;
  v_new    UUID;
  v_qa     UUID;
  v_qb     UUID;
  v_ta     UUID;
  v_tb     UUID;
  v_cname  TEXT;
  v_n1     BIGINT;
  v_n2     BIGINT;
  v_n3     BIGINT;
BEGIN
  RAISE NOTICE '=== MU-2 validation: fixtures ===';

  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  SELECT u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         '__mu2_check__' || u.tag || '@example.com', 'x', now(), now(), now(), '{}',
         json_build_object('full_name', '__mu2_check__ ' || u.tag)::jsonb
  FROM (VALUES (v_a, 'a'), (v_ag, 'ag'), (v_ag2, 'ag2'), (v_b, 'b')) AS u(id, tag);

  SELECT account_id INTO v_acc_a FROM public.profiles WHERE user_id = v_a;
  SELECT account_id INTO v_acc_b FROM public.profiles WHERE user_id = v_b;
  IF v_acc_a IS NULL OR v_acc_b IS NULL THEN
    RAISE EXCEPTION 'FAIL 0: handle_new_user não criou account/profile para os fixtures';
  END IF;

  -- agents entram em A pelo caminho real (owner de A chamando a RPC)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_a::text, true);
  PERFORM public.create_account_member(v_ag,  'agent', '__mu2_check__ ag',  NULL);
  PERFORM public.create_account_member(v_ag2, 'agent', '__mu2_check__ ag2', NULL);

  -- filas, times (seed 052) e vínculos
  INSERT INTO public.queues (account_id, name) VALUES (v_acc_a, '__mu2_check__ QA') RETURNING id INTO v_qa;
  INSERT INTO public.queues (account_id, name) VALUES (v_acc_b, '__mu2_check__ QB') RETURNING id INTO v_qb;
  SELECT id INTO v_ta FROM public.internal_teams WHERE account_id = v_acc_a ORDER BY sort_order, id LIMIT 1;
  SELECT id INTO v_tb FROM public.internal_teams WHERE account_id = v_acc_b ORDER BY sort_order, id LIMIT 1;
  IF v_ta IS NULL OR v_tb IS NULL THEN
    INSERT INTO public.internal_teams (account_id, name) VALUES (v_acc_a, '__mu2_check__ TA') RETURNING id INTO v_ta;
    INSERT INTO public.internal_teams (account_id, name) VALUES (v_acc_b, '__mu2_check__ TB') RETURNING id INTO v_tb;
  END IF;

  INSERT INTO public.queue_members (account_id, queue_id, user_id) VALUES
    (v_acc_a, v_qa, v_a), (v_acc_a, v_qa, v_ag), (v_acc_a, v_qa, v_ag2), (v_acc_b, v_qb, v_b);
  INSERT INTO public.internal_team_members (account_id, team_id, user_id) VALUES
    (v_acc_a, v_ta, v_a), (v_acc_a, v_ta, v_ag), (v_acc_a, v_ta, v_ag2), (v_acc_b, v_tb, v_b);
  INSERT INTO public.user_permission_overrides (account_id, user_id, permission_key, allowed) VALUES
    (v_acc_a, v_ag, 'queues.view', true), (v_acc_a, v_ag2, 'queues.view', true), (v_acc_b, v_b, 'queues.view', true);
  UPDATE public.queues SET primary_agent_id = v_ag WHERE id = v_qa;

  -- ----------------------------------------------------------
  -- PASS 1: a FK nova é a que valida — vínculo em A para quem não tem
  -- membership em A é recusado (23503) pela constraint nova
  -- ----------------------------------------------------------
  BEGIN
    INSERT INTO public.queue_members (account_id, queue_id, user_id) VALUES (v_acc_a, v_qa, v_b);
    RAISE EXCEPTION 'FAIL 1: queue_members aceitou usuário sem membership na account';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_cname = CONSTRAINT_NAME;
    IF v_cname <> 'queue_members_user_id_account_id_fkey' THEN
      RAISE EXCEPTION 'FAIL 1b: violação veio de outra constraint (%)', v_cname;
    END IF;
  END;
  BEGIN
    INSERT INTO public.user_permission_overrides (account_id, user_id, permission_key, allowed)
    VALUES (v_acc_a, v_b, 'flows.view', true);
    RAISE EXCEPTION 'FAIL 1c: user_permission_overrides aceitou usuário sem membership';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.internal_team_members (account_id, team_id, user_id) VALUES (v_acc_a, v_ta, v_b);
    RAISE EXCEPTION 'FAIL 1d: internal_team_members aceitou usuário sem membership';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 1: as 3 FKs novas recusam vínculo sem membership (23503)';

  -- ----------------------------------------------------------
  -- PASS 2: remove_account_member com vínculos — antes da MU-2 falhava
  -- com 23503; agora conclui e o cascade limpa só os vínculos de v_ag em A
  -- ----------------------------------------------------------
  BEGIN
    SET LOCAL ROLE authenticated;   -- claims = v_a (owner de A)
    v_new := public.remove_account_member(v_ag);
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'FAIL 2: remove_account_member falhou (% / %)', SQLSTATE, SQLERRM;
  END;

  SELECT count(*) INTO v_n1 FROM public.queue_members             WHERE user_id = v_ag AND account_id = v_acc_a;
  SELECT count(*) INTO v_n2 FROM public.internal_team_members     WHERE user_id = v_ag AND account_id = v_acc_a;
  SELECT count(*) INTO v_n3 FROM public.user_permission_overrides WHERE user_id = v_ag AND account_id = v_acc_a;
  IF v_n1 + v_n2 + v_n3 <> 0 THEN
    RAISE EXCEPTION 'FAIL 2b: vínculos de v_ag em A sobreviveram (queue=%, team=%, override=%)', v_n1, v_n2, v_n3;
  END IF;
  IF (SELECT primary_agent_id FROM public.queues WHERE id = v_qa) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 2c: queues.primary_agent_id deveria ter sido zerado (051 clear_primary_agent_on_departure)';
  END IF;
  IF (SELECT count(*) FROM public.account_members WHERE user_id = v_ag) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.account_members WHERE user_id = v_ag AND account_id = v_new AND role = 'owner') THEN
    RAISE EXCEPTION 'FAIL 2d: sync_account_members deveria deixar só a membership owner na account nova';
  END IF;
  -- demais membros de A intactos
  SELECT count(*) INTO v_n1 FROM public.queue_members             WHERE account_id = v_acc_a AND user_id IN (v_a, v_ag2);
  SELECT count(*) INTO v_n2 FROM public.internal_team_members     WHERE account_id = v_acc_a AND user_id IN (v_a, v_ag2);
  SELECT count(*) INTO v_n3 FROM public.user_permission_overrides WHERE account_id = v_acc_a AND user_id = v_ag2;
  IF v_n1 <> 2 OR v_n2 <> 2 OR v_n3 <> 1 THEN
    RAISE EXCEPTION 'FAIL 2e: cascade atingiu outros membros de A (queue=%, team=%, override=%)', v_n1, v_n2, v_n3;
  END IF;
  RAISE NOTICE 'PASS 2: remove_account_member conclui; cascade limpa só os vínculos do removido em A; primary_agent zerado';

  -- ----------------------------------------------------------
  -- PASS 3: ON UPDATE NO ACTION — mudar a chave de uma membership com
  -- vínculos é recusado (não "arrasta" vínculos para outra account)
  -- ----------------------------------------------------------
  BEGIN
    UPDATE public.account_members SET account_id = v_acc_b WHERE user_id = v_ag2 AND account_id = v_acc_a;
    RAISE EXCEPTION 'FAIL 3: UPDATE da chave de membership com vínculos deveria falhar';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 3: ON UPDATE NO ACTION bloqueia mudança de chave com vínculos';

  -- ----------------------------------------------------------
  -- PASS 4: DELETE direto da membership (caminho da MU-3) → cascade
  -- nas 3 tabelas. Deixa o profile de v_ag2 sem membership — só
  -- aceitável dentro deste ROLLBACK.
  -- ----------------------------------------------------------
  DELETE FROM public.account_members WHERE user_id = v_ag2 AND account_id = v_acc_a;
  SELECT count(*) INTO v_n1 FROM public.queue_members             WHERE user_id = v_ag2;
  SELECT count(*) INTO v_n2 FROM public.internal_team_members     WHERE user_id = v_ag2;
  SELECT count(*) INTO v_n3 FROM public.user_permission_overrides WHERE user_id = v_ag2;
  IF v_n1 + v_n2 + v_n3 <> 0 THEN
    RAISE EXCEPTION 'FAIL 4: DELETE de membership não cascateou (queue=%, team=%, override=%)', v_n1, v_n2, v_n3;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.queue_members WHERE user_id = v_a AND account_id = v_acc_a)
     OR NOT EXISTS (SELECT 1 FROM public.internal_team_members WHERE user_id = v_a AND account_id = v_acc_a) THEN
    RAISE EXCEPTION 'FAIL 4b: cascade atingiu o owner de A';
  END IF;
  RAISE NOTICE 'PASS 4: DELETE de membership cascateia nas 3 tabelas, só para aquele usuário';

  -- ----------------------------------------------------------
  -- PASS 5: nenhum efeito cross-account — B intacta
  -- ----------------------------------------------------------
  SELECT count(*) INTO v_n1 FROM public.queue_members             WHERE account_id = v_acc_b;
  SELECT count(*) INTO v_n2 FROM public.internal_team_members     WHERE account_id = v_acc_b;
  SELECT count(*) INTO v_n3 FROM public.user_permission_overrides WHERE account_id = v_acc_b;
  IF v_n1 <> 1 OR v_n2 <> 1 OR v_n3 <> 1 THEN
    RAISE EXCEPTION 'FAIL 5: account B foi afetada (queue=%, team=%, override=%)', v_n1, v_n2, v_n3;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.account_members WHERE user_id = v_b AND account_id = v_acc_b AND role = 'owner') THEN
    RAISE EXCEPTION 'FAIL 5b: membership de B alterada';
  END IF;
  RAISE NOTICE 'PASS 5: nenhum efeito cross-account';

  -- ----------------------------------------------------------
  -- PASS 6: sync_account_members segue funcionando (role/is_active)
  -- e set_member_role NÃO dispara cascade (upsert, sem DELETE)
  -- ----------------------------------------------------------
  UPDATE public.profiles SET account_role = 'admin' WHERE user_id = v_b;  -- controle: sem vínculo perdido
  IF (SELECT count(*) FROM public.queue_members WHERE user_id = v_b) <> 1
     OR (SELECT role::text FROM public.account_members WHERE user_id = v_b) <> 'admin' THEN
    RAISE EXCEPTION 'FAIL 6: mudança de papel deveria sincronizar sem apagar vínculos';
  END IF;
  RAISE NOTICE 'PASS 6: mudança de papel sincroniza e não cascateia';

  RAISE NOTICE '=== MU-2 validation: TODOS OS TESTES PASSARAM ===';
END;
$outer$;

ROLLBACK;
