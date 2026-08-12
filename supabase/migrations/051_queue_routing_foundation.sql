-- ============================================================
-- 051_queue_routing_foundation
--
-- FASE 051 — só a fundação de roteamento: onde um protocolo nasce
-- (fila padrão da conexão WhatsApp) e quem é o responsável principal
-- de uma fila/setor. NENHUM protocolo é criado por esta migration —
-- isso fica para uma fase posterior, que ainda vai chamar
-- open_ticket_for_conversation() no webhook (040/052+, não aqui).
--
-- Conteúdo, e SOMENTE isto:
--   1. whatsapp_config.default_queue_id (nullable, FK, trigger de
--      mesma conta).
--   2. queues.primary_agent_id (nullable, FK, trigger de validação
--      completa: mesma conta, profile ativo, account ativa, role
--      compatível, membro ativo da própria fila).
--   3. Dois triggers de integridade que zeram primary_agent_id quando
--      deixa de ser válido: saída/desativação de queue_members, e
--      desativação do profile.
--   4. Um trigger que impede queues.account_id mudar enquanto a fila
--      ainda é default_queue_id de alguma whatsapp_config — fecha o
--      único gap estrutural real apontado na revisão final antes de
--      aplicar (item 6): sem isso, um UPDATE de account_id via
--      service_role/console poderia deixar uma whatsapp_config
--      apontando silenciosamente para uma fila de outra conta. Não é
--      FK composta de propósito — ver o comentário junto à função,
--      mais abaixo, pelo motivo exato.
--
-- NÃO toca 049 nem 050. NÃO cria ticket. NÃO chama
-- open_ticket_for_conversation. NÃO mexe no webhook, em messages, ou
-- em conversations. NÃO cria return_ticket_to_queue,
-- start_assigned_ticket, account_ticket_summaries ou
-- messages.ticket_id — todos propostos na auditoria anterior, todos
-- deliberadamente fora do escopo desta migration.
--
-- Regra registrada para a próxima fase (não implementada aqui):
-- protocolo automático NUNCA deve ser criado sem
-- whatsapp_config.default_queue_id configurado — ausência de fila
-- padrão bloqueia a criação automática, não a substitui por um
-- fallback improvisado.
-- ============================================================

-- ============================================================
-- 1. WHATSAPP_CONFIG.DEFAULT_QUEUE_ID
-- ============================================================
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS default_queue_id UUID NULL
    REFERENCES queues(id) ON DELETE SET NULL;

-- Consultado sempre que a rota de config or a futura criação
-- automática de ticket precisar resolver "qual a fila padrão desta
-- conexão" — filtro parcial porque a esmagadora maioria das linhas
-- provavelmente fica NULL (sem fila padrão configurada).
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_default_queue
  ON whatsapp_config(default_queue_id)
  WHERE default_queue_id IS NOT NULL;

-- ---- tenancy guard — mesmo padrão de queues_validate_failure_queue_account (039) ----
--
-- Um FK puro só garante que a linha referenciada existe em algum
-- lugar de `queues` — nada impede apontar para uma fila de OUTRA
-- conta (checagens de FK não passam pela RLS, então um caller mal-
-- intencionado ou com bug poderia referenciar um id que nem consegue
-- enxergar via SELECT). Este trigger é a garantia real, no nível do
-- banco, de que "mesma conta" significa mesma conta de fato — não só
-- uma convenção de camada de aplicação.
--
-- SECURITY DEFINER (não INVOKER): a leitura do account_id real da
-- fila-alvo precisa funcionar independentemente da visibilidade RLS
-- do chamador sobre aquela fila — um INVOKER-scoped SELECT poderia
-- ser bloqueado pela RLS pra uma fila de outra conta, o que deixaria
-- este trigger cego exatamente pro caso que ele existe pra pegar,
-- enquanto o FK (que ignora RLS) ainda encontraria a linha e deixaria
-- passar a referência cross-account. A função faz um único SELECT
-- fixo, sem input além de NEW — superfície de privilégio mínima e
-- auditável pra escalada.
CREATE OR REPLACE FUNCTION public.whatsapp_config_validate_default_queue_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_account_id UUID;
BEGIN
  IF NEW.default_queue_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT account_id INTO v_target_account_id
  FROM queues
  WHERE id = NEW.default_queue_id;

  -- v_target_account_id IS NULL significa "fila não existe" — isso
  -- fica por conta do próprio erro de violação do FK; só levanta
  -- exceção aqui quando a linha foi encontrada e a conta realmente
  -- diverge.
  IF v_target_account_id IS NOT NULL AND v_target_account_id <> NEW.account_id THEN
    RAISE EXCEPTION 'default_queue_id must reference a queue in the same account';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.whatsapp_config_validate_default_queue_account() OWNER TO postgres;

-- Nenhuma role precisa CHAMAR isso diretamente — só roda amarrado ao
-- trigger abaixo. Fecha a concessão default de EXECUTE a PUBLIC que o
-- Postgres adiciona em toda função nova, mesmo padrão de todas as
-- outras SECURITY DEFINER deste projeto.
REVOKE ALL ON FUNCTION public.whatsapp_config_validate_default_queue_account()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS validate_default_queue_account ON whatsapp_config;
CREATE TRIGGER validate_default_queue_account
  BEFORE INSERT OR UPDATE OF default_queue_id, account_id ON whatsapp_config
  FOR EACH ROW
  EXECUTE FUNCTION public.whatsapp_config_validate_default_queue_account();

-- ============================================================
-- 2. QUEUES.PRIMARY_AGENT_ID
-- ============================================================
ALTER TABLE queues
  ADD COLUMN IF NOT EXISTS primary_agent_id UUID NULL
    REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_queues_primary_agent
  ON queues(primary_agent_id)
  WHERE primary_agent_id IS NOT NULL;

-- ---- validação completa do responsável principal ----
--
-- Só SET NULL (a ação do FK) garante "usuário existe". Tudo o resto
-- pedido na fase 051 — mesma conta, profile ativo, account ativa,
-- role compatível com atendimento, membro ATIVO da própria fila — não
-- dá pra expressar em CHECK (Postgres CHECK não consulta outras
-- tabelas) nem no FK, então vive neste trigger.
--
-- Ordem das checagens é deliberada: existe profile? -> mesma conta? ->
-- profile ativo? -> role compatível? -> account ativa? -> membro ativo
-- da fila? — cada uma levanta uma mensagem específica, nenhuma
-- disfarça outra.
--
-- Role compatível = 'agent' ou 'admin', nunca 'owner'/'viewer' — mesmo
-- critério que transfer_ticket_agent (049) já usa pra validar o alvo
-- de uma atribuição de ticket ("Target must have the agent or admin
-- role"); um responsável principal é, por definição, alguém que pode
-- ser atribuído a atendimentos.
--
-- SECURITY DEFINER pela mesma razão do trigger acima: a leitura de
-- profiles/accounts/queue_members não pode depender da visibilidade
-- RLS do chamador.
CREATE OR REPLACE FUNCTION public.queues_validate_primary_agent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile_account_id UUID;
  v_profile_active     BOOLEAN;
  v_profile_role       account_role_enum;
  v_account_active     BOOLEAN;
  v_is_active_member    BOOLEAN;
BEGIN
  IF NEW.primary_agent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT account_id, is_active, account_role
    INTO v_profile_account_id, v_profile_active, v_profile_role
  FROM profiles
  WHERE user_id = NEW.primary_agent_id;

  IF v_profile_account_id IS NULL THEN
    RAISE EXCEPTION 'primary_agent_id must reference a user with a profile';
  END IF;

  IF v_profile_account_id <> NEW.account_id THEN
    RAISE EXCEPTION 'primary_agent_id must belong to the same account as the queue';
  END IF;

  IF NOT v_profile_active THEN
    RAISE EXCEPTION 'primary_agent_id must be an active profile';
  END IF;

  IF v_profile_role NOT IN ('agent', 'admin') THEN
    RAISE EXCEPTION 'primary_agent_id must have the agent or admin role';
  END IF;

  SELECT is_active INTO v_account_active
  FROM accounts
  WHERE id = NEW.account_id;

  IF v_account_active IS NULL OR NOT v_account_active THEN
    RAISE EXCEPTION 'primary_agent_id cannot be set while the account is inactive';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM queue_members
    WHERE queue_id = NEW.id
      AND user_id = NEW.primary_agent_id
      AND is_active
  ) INTO v_is_active_member;

  IF NOT v_is_active_member THEN
    RAISE EXCEPTION 'primary_agent_id must be an active member of this queue';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.queues_validate_primary_agent() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.queues_validate_primary_agent()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS validate_primary_agent ON queues;
CREATE TRIGGER validate_primary_agent
  BEFORE INSERT OR UPDATE OF primary_agent_id, account_id ON queues
  FOR EACH ROW
  EXECUTE FUNCTION public.queues_validate_primary_agent();

-- ============================================================
-- 3. INTEGRIDADE — zerar primary_agent_id quando deixa de ser válido
-- ============================================================

-- ---- 3a. saída/desativação em queue_members ----
--
-- O trigger de validação acima (rodando só em INSERT/UPDATE de
-- queues) impede DEFINIR um primary_agent_id inválido, mas não reage
-- sozinho quando um responsável principal já definido sai da fila ou
-- é desativado NELA depois — sem isso, queues.primary_agent_id
-- ficaria silenciosamente apontando pra alguém que não é mais membro
-- ativo. Este trigger fecha esse buraco, disparando em DELETE
-- (remoção da fila) e em UPDATE OF is_active (desativação).
CREATE OR REPLACE FUNCTION public.queue_members_clear_primary_agent_on_departure()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Amarrado só a DELETE e UPDATE OF is_active (ver trigger abaixo).
  -- Pra UPDATE, só uma transição real ativo -> inativo deve zerar o
  -- responsável — um UPDATE que lista is_active no SET sem realmente
  -- mudar o valor (já false -> false), ou uma reativação
  -- (false -> true), não deve tocar em queues.
  IF TG_OP = 'UPDATE' AND (NEW.is_active OR NOT OLD.is_active) THEN
    RETURN NULL;
  END IF;

  UPDATE queues
  SET primary_agent_id = NULL
  WHERE id = OLD.queue_id
    AND primary_agent_id = OLD.user_id;

  RETURN NULL;
END;
$$;

ALTER FUNCTION public.queue_members_clear_primary_agent_on_departure() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.queue_members_clear_primary_agent_on_departure()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS clear_primary_agent_on_departure ON queue_members;
CREATE TRIGGER clear_primary_agent_on_departure
  AFTER DELETE OR UPDATE OF is_active ON queue_members
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_members_clear_primary_agent_on_departure();

-- ---- 3b. desativação do profile ----
--
-- Complementa 3a para o caso pedido explicitamente: profile.is_active
-- vira false SEM necessariamente passar por queue_members (o usuário
-- pode ser desativado na conta inteira sem que ninguém mexa
-- manualmente na fila). Varre TODAS as filas da conta onde esse
-- usuário é primary_agent_id — normalmente uma só, mas nada impede
-- (hoje) o mesmo usuário ser responsável principal de mais de uma
-- fila.
CREATE OR REPLACE FUNCTION public.profiles_clear_primary_agent_on_deactivation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Amarrado só a UPDATE OF is_active (ver trigger abaixo). Só uma
  -- transição real ativo -> inativo deve zerar algo.
  IF NOT OLD.is_active OR NEW.is_active THEN
    RETURN NEW;
  END IF;

  UPDATE queues
  SET primary_agent_id = NULL
  WHERE account_id = NEW.account_id
    AND primary_agent_id = NEW.user_id;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.profiles_clear_primary_agent_on_deactivation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.profiles_clear_primary_agent_on_deactivation()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS clear_primary_agent_on_deactivation ON profiles;
CREATE TRIGGER clear_primary_agent_on_deactivation
  AFTER UPDATE OF is_active ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_clear_primary_agent_on_deactivation();

-- ============================================================
-- 4. INTEGRIDADE — impedir queues.account_id mudar enquanto a fila é
--    default_queue_id de alguma whatsapp_config
-- ============================================================
--
-- Por que trigger, e não FK composta:
--
-- `queues` já tem UNIQUE(id, account_id) (idx_queues_id_account,
-- migration 039) — a base pra um FK composto existe, e
-- `queue_members` já usa exatamente esse padrão pra amarrar suas
-- próprias linhas a `queues(id, account_id)`. Mas um FK composto aqui
-- seria `FOREIGN KEY (default_queue_id, account_id) REFERENCES
-- queues(id, account_id)` — e a ação `ON DELETE SET NULL` de um FK
-- composto nula TODAS as colunas da tupla referenciadora, não só
-- `default_queue_id` sozinho. `whatsapp_config.account_id` é `NOT
-- NULL` (desde 017) — então deletar uma fila que é default_queue_id
-- de alguém faria o próprio SET NULL tentar nular `account_id`
-- também, violando o NOT NULL, e a exclusão da fila falharia com um
-- erro de constraint em vez de simplesmente limpar `default_queue_id`
-- como o comportamento atual (FK simples, ação já existente na seção
-- 1) já faz corretamente. Trocar pra um FK composto quebraria
-- exatamente o comportamento que a revisão pediu pra preservar
-- ("excluir a fila: default_queue_id vira NULL, account_id
-- permanece"). Por isso: trigger mínimo, escopado só ao caso que
-- importa (mudança de account_id numa fila REFERENCIADA), sem alterar
-- em nada a exclusão de fila nem a FK simples já existente.
--
-- Comportamento:
--   - account_id não muda de fato (mesmo valor, incluindo um UPDATE
--     que só lista a coluna no SET sem alterá-la) -> permitido,
--     sempre, sem consultar whatsapp_config.
--   - account_id muda de verdade E nenhuma whatsapp_config tem
--     default_queue_id apontando pra esta fila -> permitido, segue as
--     regras normais já existentes (RLS de queues_update, etc.).
--   - account_id muda de verdade E existe whatsapp_config com
--     default_queue_id = esta fila -> rejeitado. Não tenta adivinhar
--     qual conta "ganha" nem limpa a referência sozinho — quem for
--     mover a fila precisa primeiro limpar default_queue_id
--     explicitamente (mesmo espírito de "não corrigir silenciosamente
--     no meio de uma operação destrutiva" que os outros triggers desta
--     migration já seguem).
--
-- SECURITY DEFINER pela mesma razão dos triggers acima: a consulta a
-- `whatsapp_config` não pode depender da visibilidade RLS do
-- chamador — uma fila movida por service_role/console pode não ter
-- nenhum caller RLS-scoped no meio, e mesmo quando há, a checagem
-- precisa enxergar QUALQUER whatsapp_config que referencie a fila,
-- não só as da conta do chamador.
CREATE OR REPLACE FUNCTION public.queues_prevent_account_change_when_default_queue()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Reatribuição sem mudança real (mesmo valor) é sempre permitida —
  -- só uma mudança de fato de account_id é motivo de checagem.
  IF NEW.account_id IS NOT DISTINCT FROM OLD.account_id THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM whatsapp_config
    WHERE default_queue_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'queues.account_id cannot change while this queue is set as a whatsapp_config.default_queue_id; clear default_queue_id first';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.queues_prevent_account_change_when_default_queue() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.queues_prevent_account_change_when_default_queue()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS prevent_account_change_when_default_queue ON queues;
CREATE TRIGGER prevent_account_change_when_default_queue
  BEFORE UPDATE OF account_id ON queues
  FOR EACH ROW
  EXECUTE FUNCTION public.queues_prevent_account_change_when_default_queue();

-- ============================================================
-- VALIDAÇÃO MANUAL (não existe harness de teste SQL automatizado
-- neste repositório — mesmo aviso já registrado em 034/049/050).
-- Rodar contra staging, nunca produção, antes/depois de aplicar.
--
--  1. whatsapp_config.default_queue_id = fila da PRÓPRIA conta ->
--     sucesso.
--  2. whatsapp_config.default_queue_id = fila de OUTRA conta ->
--     rejeitado ("must reference a queue in the same account").
--  3. whatsapp_config.default_queue_id = fila inexistente -> rejeitado
--     pelo FK (violação de chave estrangeira), não pelo trigger.
--  4. Deletar a fila apontada por default_queue_id -> a linha de
--     whatsapp_config sobrevive, default_queue_id vira NULL (ação do
--     FK, nenhum trigger envolvido).
--
--  5. queues.primary_agent_id = usuário que é profile ativo + membro
--     ativo da PRÓPRIA fila + role agent/admin -> sucesso.
--  6. primary_agent_id = usuário de OUTRA conta -> rejeitado ("must
--     belong to the same account").
--  7. primary_agent_id = usuário sem nenhum profile -> rejeitado
--     ("must reference a user with a profile").
--  8. primary_agent_id = usuário com profile ativo mas NÃO membro
--     desta fila (queue_members inexistente) -> rejeitado ("must be
--     an active member of this queue").
--  9. primary_agent_id = usuário membro desta fila mas
--     queue_members.is_active=false -> rejeitado (mesma mensagem do
--     item 8 — from the trigger's perspective, "não é membro ativo"
--     cobre os dois casos).
-- 10. primary_agent_id = usuário com profile.is_active=false ->
--     rejeitado ("must be an active profile").
-- 11. primary_agent_id = usuário com account_role='viewer' ou 'owner'
--     -> rejeitado ("must have the agent or admin role").
-- 12. primary_agent_id definido, depois account.is_active vira false
--     -> qualquer UPDATE subsequente que RE-toque primary_agent_id
--     (mesmo pro mesmo valor) passa a ser rejeitado ("cannot be set
--     while the account is inactive"); o valor já gravado antes da
--     desativação da conta NÃO é limpo retroativamente por este
--     trigger (ele só valida em INSERT/UPDATE, não varre o banco) —
--     ver PARTE H do relatório para essa lacuna.
--
-- 13. Remover (DELETE) a queue_members do responsável principal ->
--     queues.primary_agent_id vira NULL.
-- 14. Desativar (UPDATE is_active=false) a queue_members do
--     responsável principal -> queues.primary_agent_id vira NULL.
-- 15. Desativar (UPDATE is_active=false) o profile do responsável
--     principal, SEM tocar queue_members -> queues.primary_agent_id
--     vira NULL mesmo assim (trigger 3b).
-- 16. Reativar queue_members.is_active de false -> true, ou
--     profiles.is_active de false -> true -> NÃO restaura
--     primary_agent_id automaticamente (a limpeza é de mão única, por
--     design — reatribuir é uma decisão manual de admin, nunca
--     silenciosa).
-- 17. UPDATE em queue_members que lista is_active no SET sem mudar o
--     valor (ex.: já false, SET is_active=false, weight=10) -> NÃO
--     dispara limpeza redundante desnecessária (guard explícito no
--     corpo da função).
--
-- 18. whatsapp_config da conta A com default_queue_id = fila A ->
--     sucesso (mesmo caso do item 1, repetido aqui como base dos
--     itens 19-22 abaixo).
-- 19. Com o setup do item 18, tentar UPDATE queues SET account_id =
--     <conta B> na fila A -> REJEITADO
--     ("queues.account_id cannot change while this queue is set as a
--     whatsapp_config.default_queue_id; clear default_queue_id
--     first"). whatsapp_config.default_queue_id e queues.account_id
--     permanecem exatamente como estavam antes da tentativa.
-- 20. Com o setup do item 18: primeiro UPDATE whatsapp_config SET
--     default_queue_id = NULL, depois UPDATE queues SET account_id =
--     <conta B> na mesma fila -> permitido, segue as regras normais
--     já existentes (RLS de queues_update) — o trigger novo não entra
--     em ação porque nenhuma whatsapp_config mais referencia a fila.
-- 21. Fila SEM nenhuma whatsapp_config apontando pra ela -> UPDATE
--     queues SET account_id = <outra conta> -> comportamento
--     inalterado por esta migration, segue as regras já existentes
--     (RLS/demais triggers).
-- 22. Deletar (DELETE) uma fila que é default_queue_id de uma
--     whatsapp_config -> continua permitido exatamente como no item
--     4: default_queue_id vira NULL via ON DELETE SET NULL (FK
--     simples da seção 1, inalterada), whatsapp_config.account_id
--     permanece intacto. O trigger novo desta seção só escuta
--     `UPDATE OF account_id` — nunca dispara em DELETE, de propósito,
--     pra não interferir nesse caminho.
-- ============================================================
