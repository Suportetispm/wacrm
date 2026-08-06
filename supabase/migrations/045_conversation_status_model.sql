-- ============================================================
-- 045_conversation_status_model
--
-- FASE 5C — amplia conversations.status de três valores
-- (open/pending/closed) para cinco (pending/in_progress/
-- waiting_customer/closed/finalized), separando com mais precisão o
-- ciclo de atendimento do que o modelo original permitia.
--
-- NÃO altera tickets.status (continua com três valores, sem
-- sincronização — ver auditoria da FASE 5A/5C), não cria trigger, não
-- altera unread_count nem assigned_agent_id, não é destrutiva.
-- ------------------------------------------------------------

DO $$
DECLARE
  v_constraint_name  TEXT;
  v_unexpected_count INTEGER;
BEGIN
  -- ------------------------------------------------------------
  -- 1. Falha alto e claro se já existir alguma linha com um status
  --    fora dos três valores que esta migration sabe converter — não
  --    faz sentido seguir adivinhando o que fazer com um valor
  --    desconhecido.
  -- ------------------------------------------------------------
  SELECT count(*) INTO v_unexpected_count
  FROM conversations
  WHERE status NOT IN ('open', 'pending', 'closed');

  IF v_unexpected_count > 0 THEN
    RAISE EXCEPTION
      'conversations has % row(s) with a status outside (open, pending, closed) — refusing to migrate blindly',
      v_unexpected_count;
  END IF;

  -- ------------------------------------------------------------
  -- 2. Conversão dos dados ANTES de trocar o CHECK — nunca o
  --    contrário, ou o UPDATE abaixo violaria a constraint antiga
  --    (que ainda não aceita 'in_progress') no meio do caminho.
  --
  --    Estratégia (conforme decidido na auditoria da FASE 5C):
  --      open    -> in_progress  (uma conversa "aberta" no modelo
  --                                antigo já tinha alguém trabalhando
  --                                nela — o equivalente mais próximo
  --                                é "em atendimento", não "pendente")
  --      pending -> pending      (mesmo nome, mesmo significado)
  --      closed  -> closed       (mesmo nome, mesmo significado)
  --
  --    'waiting_customer' e 'finalized' são estados novos, sem
  --    equivalente no modelo antigo — nenhuma linha existente recebe
  --    esses valores nesta migration; eles só passam a existir a
  --    partir de mudanças de status feitas depois desta migration.
  -- ------------------------------------------------------------
  UPDATE conversations SET status = 'in_progress' WHERE status = 'open';

  -- ------------------------------------------------------------
  -- 3. Remove o CHECK antigo pelo nome REAL (descoberto via
  --    pg_constraint, nunca um nome adivinhado/hardcoded) — a coluna
  --    foi criada em 001_initial_schema.sql com um CHECK inline sem
  --    nome explícito, então o nome é o que o Postgres gerou
  --    automaticamente; procurar por nome+tipo+definição evita
  --    depender dessa convenção de nomenclatura estar certa.
  -- ------------------------------------------------------------
  SELECT con.conname INTO v_constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'conversations'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%status%IN%';

  IF v_constraint_name IS NULL THEN
    RAISE EXCEPTION
      'could not find the existing status CHECK constraint on conversations — refusing to proceed without dropping it by name';
  END IF;

  EXECUTE format('ALTER TABLE conversations DROP CONSTRAINT %I', v_constraint_name);

  -- ------------------------------------------------------------
  -- 4. Novo CHECK com os cinco valores.
  -- ------------------------------------------------------------
  ALTER TABLE conversations
    ADD CONSTRAINT conversations_status_check
    CHECK (status IN ('pending', 'in_progress', 'waiting_customer', 'closed', 'finalized'));

  -- ------------------------------------------------------------
  -- 5. DEFAULT: 'pending', não 'in_progress'.
  --
  --    Justificativa: uma conversa recém-criada (find-or-create do
  --    webhook, ou "Nova conversa" no CRM) ainda não tem nenhum
  --    agente trabalhando nela — semanticamente ela está aguardando
  --    triagem/primeiro atendimento, o que é exatamente o que
  --    'pending' significa. 'in_progress' implicaria um agente já
  --    engajado, o que não é verdade no momento da criação. Isso
  --    também é mais fiel ao papel que o antigo default 'open'
  --    cumpria (linha nova, nada feito ainda) do que 'in_progress'
  --    seria.
  -- ------------------------------------------------------------
  ALTER TABLE conversations ALTER COLUMN status SET DEFAULT 'pending';

  -- ------------------------------------------------------------
  -- 6. Checagem de sanidade pós-migration — garante que nenhuma linha
  --    ficou fora do novo conjunto de valores válidos.
  -- ------------------------------------------------------------
  SELECT count(*) INTO v_unexpected_count
  FROM conversations
  WHERE status NOT IN ('pending', 'in_progress', 'waiting_customer', 'closed', 'finalized');

  IF v_unexpected_count > 0 THEN
    RAISE EXCEPTION
      'post-migration sanity check failed: % row(s) still have an invalid status',
      v_unexpected_count;
  END IF;
END;
$$;
