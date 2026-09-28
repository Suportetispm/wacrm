-- ============================================================
-- 081_account_members_membership_fks  (ETAPA MU-2)
--
-- Reaponta as 3 FKs compostas que representam "vínculo do usuário
-- DENTRO de uma account" de profiles(user_id, account_id) para
-- account_members(user_id, account_id):
--
--   queue_members(user_id, account_id)
--   internal_team_members(user_id, account_id)
--   user_permission_overrides(user_id, account_id)
--       → account_members(user_id, account_id)
--         ON DELETE CASCADE  ON UPDATE NO ACTION   (iguais às atuais)
--
-- NÃO FAZ: não altera dados, profiles, account_members, deals
-- (deals.assigned_to → profiles.id é identidade global e fica), o
-- trigger sync_account_members (079), account_has_any_data (080),
-- RLS/policies, índices, RPCs ou runtime.
--
-- ON UPDATE NO ACTION (mantido): nada no sistema faz UPDATE de
-- account_members.user_id/account_id — o trigger da 079 move membership
-- com DELETE + INSERT. NO ACTION preserva o comportamento atual e impede
-- que um UPDATE futuro de chave "arraste" vínculos de uma account para
-- outra em silêncio.
--
-- EFEITO INTENCIONAL (ON DELETE CASCADE a partir de account_members):
--   Remover uma membership apaga os vínculos daquele usuário NAQUELA
--   account (filas, times internos, overrides). Com o trigger da 079,
--   isso passa a acontecer também quando profiles.account_id muda
--   (remove_account_member, redeem_invitation, attach): o trigger apaga
--   a membership antiga → cascade. Hoje esses UPDATEs falham com 23503
--   quando o usuário tem vínculos (FK antiga ON UPDATE NO ACTION em
--   profiles) — a MU-2 corrige isso. Efeito colateral encadeado:
--   queue_members_clear_primary_agent_on_departure (051) zera
--   queues.primary_agent_id quando o removido era o responsável.
--
-- ROBUSTEZ:
--   - FKs antigas localizadas pela DEFINIÇÃO (tabela, colunas, alvo),
--     não por nome presumido; exige exatamente 1 por tabela, com
--     ON DELETE CASCADE / ON UPDATE NO ACTION / não deferrable — senão
--     aborta (divergência de schema = parar e investigar).
--   - Aborta se houver qualquer linha sem membership correspondente
--     (não deveria: profiles ↔ account_members é 1:1 desde a 079).
--   - Nomes novos explícitos (<tabela>_user_id_account_id_fkey — o mesmo
--     padrão que o Postgres gerou para as antigas).
--   - Tudo num único bloco (atômico). lock_timeout curto: se não obtiver
--     os locks, falha sem enfileirar escritas do app atrás dele.
--   - Idempotente: tabela já migrada (FK nova presente e antiga ausente)
--     é pulada.
--
-- ROLLBACK (manual, se necessário): mesmo bloco com alvo invertido —
--   DROP <tabela>_user_id_account_id_fkey; ADD FOREIGN KEY (user_id,
--   account_id) REFERENCES profiles(user_id, account_id) ON DELETE
--   CASCADE. Válido enquanto profiles ↔ account_members for 1:1.
--
-- Pré-requisito: supabase/validation/mu2_account_members_fks_preflight.sql.
-- Validação:     supabase/validation/mu2_account_members_fks_check.sql.
-- ============================================================

DO $mu2$
DECLARE
  v_tbl        TEXT;
  v_rel        REGCLASS;
  v_new_name   TEXT;
  v_old        RECORD;
  v_old_count  INTEGER;
  v_has_new    BOOLEAN;
  v_orphans    BIGINT;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  -- Pré-condição: alvo único (user_id, account_id) em account_members (079)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.account_members'::regclass
      AND conname = 'account_members_user_id_account_id_key'
      AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'MU-2: account_members_user_id_account_id_key ausente — 079 não aplicada?';
  END IF;

  FOREACH v_tbl IN ARRAY ARRAY['queue_members', 'internal_team_members', 'user_permission_overrides']
  LOOP
    v_rel      := format('public.%I', v_tbl)::regclass;
    v_new_name := v_tbl || '_user_id_account_id_fkey';

    -- FKs (user_id, account_id) → <alvo>(user_id, account_id) desta tabela
    SELECT count(*) INTO v_old_count
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.conrelid = v_rel
      AND c.confrelid = 'public.profiles'::regclass
      AND (SELECT array_agg(a.attname ORDER BY k.ord)
             FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
          = ARRAY['user_id', 'account_id']::name[];

    SELECT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.contype = 'f' AND c.conrelid = v_rel
        AND c.confrelid = 'public.account_members'::regclass
        AND (SELECT array_agg(a.attname ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
            = ARRAY['user_id', 'account_id']::name[]
    ) INTO v_has_new;

    IF v_has_new AND v_old_count = 0 THEN
      RAISE NOTICE 'MU-2: % já aponta para account_members — pulando', v_tbl;
      CONTINUE;
    END IF;

    IF v_has_new OR v_old_count <> 1 THEN
      RAISE EXCEPTION 'MU-2: estado inesperado em % (FKs para profiles = %, FK para account_members = %)',
        v_tbl, v_old_count, v_has_new;
    END IF;

    SELECT c.conname, c.confdeltype, c.confupdtype, c.condeferrable,
           (SELECT array_agg(a.attname ORDER BY k.ord)
              FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS ref_cols
      INTO v_old
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.conrelid = v_rel
      AND c.confrelid = 'public.profiles'::regclass
      AND (SELECT array_agg(a.attname ORDER BY k.ord)
             FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
          = ARRAY['user_id', 'account_id']::name[];

    IF v_old.ref_cols IS DISTINCT FROM ARRAY['user_id', 'account_id']::name[]
       OR v_old.confdeltype <> 'c'      -- CASCADE
       OR v_old.confupdtype <> 'a'      -- NO ACTION
       OR v_old.condeferrable THEN
      RAISE EXCEPTION 'MU-2: FK % em % diverge do esperado (ref=%, on_delete=%, on_update=%, deferrable=%)',
        v_old.conname, v_tbl, v_old.ref_cols, v_old.confdeltype, v_old.confupdtype, v_old.condeferrable;
    END IF;

    -- Órfãos em relação ao alvo novo
    EXECUTE format(
      'SELECT count(*) FROM public.%I x
        WHERE NOT EXISTS (SELECT 1 FROM public.account_members m
                           WHERE m.user_id = x.user_id AND m.account_id = x.account_id)',
      v_tbl
    ) INTO v_orphans;
    IF v_orphans > 0 THEN
      RAISE EXCEPTION 'MU-2: % linha(s) em % sem membership em account_members — abortando', v_orphans, v_tbl;
    END IF;

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_tbl, v_old.conname);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I
         FOREIGN KEY (user_id, account_id)
         REFERENCES public.account_members (user_id, account_id)
         ON DELETE CASCADE ON UPDATE NO ACTION',
      v_tbl, v_new_name
    );

    RAISE NOTICE 'MU-2: % — % (profiles) substituída por % (account_members)', v_tbl, v_old.conname, v_new_name;
  END LOOP;
END;
$mu2$;

-- ============================================================
-- VALIDAÇÃO MANUAL — ver
-- supabase/validation/mu2_account_members_fks_check.sql.
-- NÃO executado automaticamente por esta migration.
-- ============================================================
