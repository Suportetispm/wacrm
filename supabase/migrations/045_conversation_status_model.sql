-- ============================================================
-- 045_conversation_status_model
--
-- FASE 5C — amplia conversations.status de três valores
-- (open/pending/closed) para cinco (pending/in_progress/
-- waiting_customer/closed/finalized), separando com mais precisão o
-- ciclo de atendimento do que o modelo original permitia.
--
-- NÃO altera tickets.status (continua com três valores, sem
-- sincronização — ver auditoria da FASE 5A/5C), não cria trigger,
-- não cria RPC, não altera unread_count nem assigned_agent_id, não é
-- destrutiva.
--
-- Ordem corrigida nesta revisão (FASE 6B.3): o CHECK antigo só aceita
-- open/pending/closed, então remover a constraint tem que acontecer
-- ANTES de converter open -> in_progress — caso contrário o UPDATE
-- violaria a constraint antiga no meio do caminho. A ordem final é:
--   1. validar dados existentes
--   2. localizar o CHECK antigo
--   3. remover o CHECK antigo
--   4. converter open -> in_progress
--   5. criar o novo CHECK
--   6. alterar o DEFAULT
--   7. validar o estado final
-- ------------------------------------------------------------

DO $$
DECLARE
  v_constraint_name  TEXT;
  v_unexpected_count INTEGER;
BEGIN
  -- ------------------------------------------------------------
  -- 1. Validação inicial — falha alto e claro se já existir alguma
  --    linha com um status fora dos três valores que esta migration
  --    sabe converter. Não tenta adivinhar o que fazer com um valor
  --    desconhecido, e a mensagem de erro carrega apenas a contagem
  --    (nunca ids de conversas).
  -- ------------------------------------------------------------
  SELECT count(*) INTO v_unexpected_count
  FROM public.conversations
  WHERE status NOT IN ('open', 'pending', 'closed');

  IF v_unexpected_count > 0 THEN
    RAISE EXCEPTION
      'conversations has % row(s) with a status outside (open, pending, closed) — refusing to migrate blindly',
      v_unexpected_count;
  END IF;

  -- ------------------------------------------------------------
  -- 2. Localiza o CHECK antigo pelo nome REAL (descoberto via
  --    pg_constraint/pg_class/pg_namespace, nunca um nome
  --    adivinhado/hardcoded) — a coluna foi criada em
  --    001_initial_schema.sql com um CHECK inline sem nome explícito,
  --    então o nome é o que o Postgres gerou automaticamente.
  --    Restringe explicitamente a schema public e tabela conversations
  --    para não pegar constraint de outra tabela com o mesmo nome em
  --    outro schema.
  -- ------------------------------------------------------------
  SELECT con.conname INTO v_constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'conversations'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%status%IN%';

  IF v_constraint_name IS NULL THEN
    RAISE EXCEPTION
      'could not find the existing status CHECK constraint on public.conversations — refusing to proceed without dropping it by name';
  END IF;

  -- ------------------------------------------------------------
  -- 3. Remove o CHECK antigo ANTES de converter os dados — essa é a
  --    correção desta revisão: com a constraint antiga ainda no
  --    lugar, o UPDATE do passo 4 (open -> in_progress) seria
  --    rejeitado, porque 'in_progress' não está entre os valores que
  --    ela aceita.
  -- ------------------------------------------------------------
  EXECUTE format('ALTER TABLE public.conversations DROP CONSTRAINT %I', v_constraint_name);

  -- ------------------------------------------------------------
  -- 4. Conversão dos dados legados, agora sem constraint no caminho.
  --
  --    Estratégia (conforme decidido na auditoria da FASE 5C):
  --      open    -> in_progress  (uma conversa "aberta" no modelo
  --                                antigo já tinha alguém trabalhando
  --                                nela — o equivalente mais próximo
  --                                é "em atendimento", não "pendente")
  --      pending -> pending      (mesmo nome, mesmo significado, não
  --                                é tocado)
  --      closed  -> closed       (mesmo nome, mesmo significado, não
  --                                é tocado)
  --
  --    'waiting_customer' e 'finalized' são estados novos, sem
  --    equivalente no modelo antigo — nenhuma linha existente recebe
  --    esses valores nesta migration; eles só passam a existir a
  --    partir de mudanças de status feitas depois desta migration.
  -- ------------------------------------------------------------
  UPDATE public.conversations SET status = 'in_progress' WHERE status = 'open';

  -- ------------------------------------------------------------
  -- 5. Novo CHECK com os cinco valores.
  -- ------------------------------------------------------------
  ALTER TABLE public.conversations
    ADD CONSTRAINT conversations_status_check
    CHECK (status IN ('pending', 'in_progress', 'waiting_customer', 'closed', 'finalized'));

  -- ------------------------------------------------------------
  -- 6. DEFAULT: 'pending', não 'in_progress'.
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
  ALTER TABLE public.conversations ALTER COLUMN status SET DEFAULT 'pending';

  -- ------------------------------------------------------------
  -- 7. Checagem de sanidade pós-migration — garante que nenhuma
  --    linha ficou fora do novo conjunto de valores válidos. A
  --    mensagem carrega apenas a contagem, nunca ids de conversas.
  -- ------------------------------------------------------------
  SELECT count(*) INTO v_unexpected_count
  FROM public.conversations
  WHERE status NOT IN ('pending', 'in_progress', 'waiting_customer', 'closed', 'finalized');

  IF v_unexpected_count > 0 THEN
    RAISE EXCEPTION
      'post-migration sanity check failed: % row(s) still have an invalid status',
      v_unexpected_count;
  END IF;
END;
$$;
