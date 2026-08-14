-- ============================================================
-- 052_internal_tickets_foundation
--
-- 052-INT-A — fundação do módulo "Chamados Internos": schema,
-- constraints, indexes, triggers de integridade, RLS, grants, seed
-- inicial e os dois únicos helpers estritamente necessários para
-- segurança/numeração (alocação atômica de código sequencial +
-- validação de tenancy). Nenhuma página, componente, formulário, API
-- de CRUD, comentário de UI ou anexo é criado nesta fase — ver o
-- cabeçalho de cada bloco abaixo para o que fica para 052-INT-B em
-- diante.
--
-- Deliberadamente NÃO toca: tickets, ticket_events, queues,
-- queue_members, conversations, messages, whatsapp_config, UAZAPI,
-- Meta, automations, flows, ou qualquer coisa das migrations
-- 049/050/051. O único ponto de contato com uma tabela pré-existente
-- é um trigger NOVO e independente em `accounts` (seed de defaults)
-- e outro em `profiles` (limpeza de responsável ao desativar usuário)
-- — nenhum dos dois altera `handle_new_user()`, `platform_create_account()`
-- ou qualquer trigger/função já existente.
--
-- Namespace de tabelas 100% novo (`internal_*`), sem nenhuma FK para
-- `tickets`/`queues`/`conversations` — ver a auditoria da fase
-- anterior para a justificativa completa de não reaproveitar essas
-- tabelas.
--
-- Idempotente — mesmo padrão do resto do projeto (IF NOT EXISTS /
-- DROP-then-CREATE para policies e triggers).
--
-- HARDENING pós-revisão A–J (ver seção 2.10): id/account_id/
-- created_at são imutáveis depois do INSERT em todas as 9 tabelas
-- client-facing deste arquivo; internal_code/created_by também em
-- internal_tickets; ticket_id/author_id também em
-- internal_ticket_comments. Guard incondicional (nem service_role
-- escapa), via um único trigger genérico reutilizado 9 vezes.
-- ============================================================

-- ============================================================
-- 1. TABELAS
-- ============================================================

-- ---- 1.1 internal_ticket_counters -----------------------------
-- Mesmo papel de account_ticket_counters (040), isolado: numeração de
-- Chamados Internos nunca compartilha contador com Atendimentos
-- WhatsApp, mesmo dentro da mesma account. Zero políticas de
-- cliente — só é tocada por allocate_internal_ticket_number() abaixo.
CREATE TABLE IF NOT EXISTS internal_ticket_counters (
  account_id  UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  next_number BIGINT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE internal_ticket_counters ENABLE ROW LEVEL SECURITY;
-- Sem policies — authenticated/anon têm zero acesso por padrão.

-- ---- 1.2 internal_ticket_types ---------------------------------
-- created_by REMOVIDO nesta revisão (auditoria bloqueante): a coluna
-- só existia em internal_ticket_types — nenhum dos outros 4 catálogos
-- (statuses/stages/companies/teams) a tem — nunca era setada pelo seed
-- (2.8 só insere account_id/name/sort_order), nenhuma policy de RLS a
-- referenciava, e nenhum trigger validava sua tenancy (diferente de
-- created_by em internal_tickets, que É validado por
-- internal_tickets_validate_tenancy). Um campo de auditoria sem
-- NENHUMA proteção de tenancy, presente em só uma de cinco tabelas
-- irmãs idênticas em propósito, é pior do que não ter o campo: some
-- código futuro poderia passar a confiar nele sem que nada no banco
-- jamais tivesse garantido que aponta para um usuário da mesma
-- account. Como a tabela nunca foi aplicada no Supabase (migration
-- ainda não executada), remover agora é só editar o CREATE TABLE —
-- sem ALTER TABLE DROP COLUMN, sem backfill, sem risco de perda de
-- dado real. Se "quem criou este tipo de chamado" vier a ser um
-- requisito de verdade numa fase futura, a forma correta de
-- reintroduzir é replicar exatamente o padrão já validado de
-- internal_tickets.created_by (NOT NULL, RESTRICT, validado em
-- internal_tickets_validate_tenancy, imutável via
-- prevent_system_column_change) — e, nesse caso, decidir also se os
-- outros 4 catálogos precisam do mesmo campo, para não reabrir esta
-- mesma assimetria.
CREATE TABLE IF NOT EXISTS internal_ticket_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);

CREATE INDEX IF NOT EXISTS idx_internal_ticket_types_account_active
  ON internal_ticket_types(account_id, is_active);

-- ---- 1.3 internal_ticket_statuses -------------------------------
-- is_terminal: "representa encerramento ou não" (nunca lógica baseada
-- no nome textual). is_default: status inicial de todo chamado novo —
-- adição em relação ao pedido original, necessária para a futura RPC
-- de criação saber com qual status abrir o chamado.
CREATE TABLE IF NOT EXISTS internal_ticket_statuses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#3b82f6',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  is_terminal BOOLEAN NOT NULL DEFAULT false,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, name),
  -- Um status desativado não pode ao mesmo tempo ser o default de
  -- novos chamados — evita estado inconsistente.
  CHECK (NOT is_default OR is_active)
);

CREATE INDEX IF NOT EXISTS idx_internal_ticket_statuses_account_active
  ON internal_ticket_statuses(account_id, is_active);

-- No máximo um status default por account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_ticket_statuses_one_default
  ON internal_ticket_statuses(account_id) WHERE is_default;

-- ---- 1.4 internal_ticket_stages ----------------------------------
-- Etapa é conceito independente de status (SOLICITAÇÃO -> EM ANÁLISE
-- -> ENCERRADO é o fluxo visual da barra de etapas, não o status
-- operacional do chamado).
CREATE TABLE IF NOT EXISTS internal_ticket_stages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  is_terminal BOOLEAN NOT NULL DEFAULT false,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, name),
  CHECK (NOT is_default OR is_active)
);

CREATE INDEX IF NOT EXISTS idx_internal_ticket_stages_account_active
  ON internal_ticket_stages(account_id, is_active);

CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_ticket_stages_one_default
  ON internal_ticket_stages(account_id) WHERE is_default;

-- ---- 1.5 internal_companies ---------------------------------------
-- Catálogo configurável de empresas RELACIONADAS a chamados internos.
-- Deliberadamente distinto de `accounts` (que é o tenant/dono dos
-- dados) — uma account pode ter N internal_companies cadastradas
-- (seus próprios clientes/parceiros/unidades), nenhuma delas é a
-- conta em si. Sem seed — não há um conjunto padrão de empresas que
-- faça sentido para toda conta; cada tenant cadastra as suas.
CREATE TABLE IF NOT EXISTS internal_companies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);

CREATE INDEX IF NOT EXISTS idx_internal_companies_account_active
  ON internal_companies(account_id, is_active);

-- ---- 1.6 internal_teams --------------------------------------------
-- Equipes PRÓPRIAS dos Chamados Internos — nunca `queues` (que carrega
-- campos de roteamento de chatbot/WhatsApp sem sentido aqui; ver
-- PARTE C da auditoria anterior).
CREATE TABLE IF NOT EXISTS internal_teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
  -- primary_member_id ("responsável principal") fica para uma fase
  -- futura, se necessário — omitido agora (campo específico só quando
  -- necessário, conforme instrução).
);

CREATE INDEX IF NOT EXISTS idx_internal_teams_account_active
  ON internal_teams(account_id, is_active);

-- FK target para a FK composta de internal_team_members abaixo — (id)
-- sozinho já é único via PK, mas o Postgres exige um unique
-- constraint/index no EXATO conjunto de colunas composto para servir
-- de alvo de FK composta. Mesmo padrão de idx_queues_id_account (039).
CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_teams_id_account
  ON internal_teams(id, account_id);

-- ---- 1.7 internal_team_members --------------------------------------
-- Mesmo padrão de FK composta de queue_members (039): tenancy
-- 100% declarativa via (team_id, account_id) e (user_id, account_id),
-- sem precisar de trigger para a parte "mesma conta". A parte "usuário
-- ativo" NÃO é coberta por FK nenhuma — ver
-- internal_team_members_validate_active() na seção 2.
CREATE TABLE IF NOT EXISTS internal_team_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  team_id    UUID NOT NULL,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id),
  FOREIGN KEY (team_id, account_id) REFERENCES internal_teams(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, account_id) REFERENCES profiles(user_id, account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_internal_team_members_account ON internal_team_members(account_id);
CREATE INDEX IF NOT EXISTS idx_internal_team_members_user ON internal_team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_internal_team_members_team_active
  ON internal_team_members(team_id, is_active);

-- ---- 1.8 internal_tickets ---------------------------------------------
-- Núcleo do módulo. Todas as referências de catálogo (type/status/
-- stage/team/company) são por id, nunca por nome — os catálogos
-- continuam livres para rename/reorder/desativar sem quebrar nada
-- aqui. priority foi DELIBERADAMENTE OMITIDA nesta fase (fora do
-- requisito atual). "observações" da auditoria original também foi
-- omitida como coluna própria — usar comentários evita dois campos de
-- texto livre concorrentes com `description`.
CREATE TABLE IF NOT EXISTS internal_tickets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  internal_code     BIGINT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT NULL,
  type_id           UUID NOT NULL REFERENCES internal_ticket_types(id),
  status_id         UUID NOT NULL REFERENCES internal_ticket_statuses(id),
  stage_id          UUID NULL REFERENCES internal_ticket_stages(id),
  team_id           UUID NULL REFERENCES internal_teams(id),
  internal_company_id UUID NULL REFERENCES internal_companies(id),
  assigned_user_id  UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  -- RESTRICT (não SET NULL): quem abriu um chamado interno é
  -- informação de auditoria que não deve virar NULL silenciosamente —
  -- mesmo raciocínio de accounts.owner_user_id (017). Exclusão física
  -- de usuário com chamados criados é o caso excepcional que fica
  -- bloqueado, não o caminho normal.
  created_by        UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  scheduled_at      TIMESTAMPTZ NULL,
  completed_at      TIMESTAMPTZ NULL,
  cancelled_at      TIMESTAMPTZ NULL,
  cancel_reason     TEXT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, internal_code)
);

CREATE INDEX IF NOT EXISTS idx_internal_tickets_account_status
  ON internal_tickets(account_id, status_id);
CREATE INDEX IF NOT EXISTS idx_internal_tickets_account_assigned
  ON internal_tickets(account_id, assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_internal_tickets_account_team
  ON internal_tickets(account_id, team_id);
CREATE INDEX IF NOT EXISTS idx_internal_tickets_created_by ON internal_tickets(created_by);

-- ---- 1.9 internal_ticket_comments ---------------------------------
-- Soft-delete desde a fundação: deleted_at/deleted_by. Nunca DELETE
-- físico pelo cliente — "excluir" um comentário é um UPDATE que marca
-- essas duas colunas, preservando o histórico.
CREATE TABLE IF NOT EXISTS internal_ticket_comments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ticket_id  UUID NOT NULL REFERENCES internal_tickets(id) ON DELETE CASCADE,
  author_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  body       TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NULL,
  deleted_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Biconditional: deleted_by só existe junto de deleted_at.
  CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_internal_ticket_comments_ticket
  ON internal_ticket_comments(ticket_id, created_at);

-- ---- 1.10 internal_ticket_events -----------------------------------
-- Append-only, mesmo modelo de ticket_events (040). Nesta fase só a
-- tabela + segurança são criadas — nenhum trigger de diff genérico e
-- nenhum auto-log de comentário ainda (ficam para 052-INT-C/052-INT-F).
CREATE TABLE IF NOT EXISTS internal_ticket_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ticket_id      UUID NOT NULL REFERENCES internal_tickets(id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL CHECK (event_type IN (
    'created', 'title_changed', 'description_changed', 'type_changed',
    'status_changed', 'stage_changed', 'team_changed', 'assignee_changed',
    'company_changed', 'scheduled_at_changed', 'comment_added',
    'completed', 'cancelled'
  )),
  actor_user_id  UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  from_value     TEXT NULL,
  to_value       TEXT NULL,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_internal_ticket_events_ticket_created
  ON internal_ticket_events(ticket_id, created_at DESC);

-- ============================================================
-- 2. FUNÇÕES E TRIGGERS
-- ============================================================

-- ---- 2.1 update_updated_at_column() ---------------------------------
-- Já existe (001_initial_schema.sql) — só vinculada às tabelas novas
-- abaixo, não recriada.

DROP TRIGGER IF EXISTS set_updated_at ON internal_ticket_counters;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON internal_ticket_counters
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON internal_ticket_types;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON internal_ticket_types
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON internal_ticket_statuses;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON internal_ticket_statuses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON internal_ticket_stages;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON internal_ticket_stages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON internal_companies;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON internal_companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON internal_teams;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON internal_teams
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON internal_team_members;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON internal_team_members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON internal_tickets;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON internal_tickets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON internal_ticket_comments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON internal_ticket_comments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---- 2.2 allocate_internal_ticket_number(p_account_id) --------------
-- Único ponto de alocação do internal_code. Atômico via
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING — nunca
-- SELECT max(internal_code) + 1, que teria condição de corrida entre
-- duas criações concorrentes na mesma account.
--
-- HARDENING (revisão pós A–J): confirmado nesta passagem — nenhuma
-- rota/RPC externa chama esta função hoje, então NINGUÉM precisa de
-- EXECUTE nesta fase, nem service_role. REVOKE ALL cobre PUBLIC/anon/
-- authenticated/service_role e NENHUM GRANT é concedido a role
-- nenhuma (nem abaixo, nem em nenhum outro ponto deste arquivo — não
-- há motivo técnico real para service_role ter acesso direto agora:
-- o único caller planejado, create_internal_ticket (052-INT-C), vai
-- rodar SECURITY DEFINER como postgres, e o dono de uma função sempre
-- pode executar suas próprias funções independente de REVOKE, que só
-- restringe OUTRAS roles). A RPC futura é quem vai chamar esta função
-- internamente e vai receber o GRANT adequado ao seu próprio modelo
-- de chamador, decidido naquela fase — não aqui.
CREATE OR REPLACE FUNCTION public.allocate_internal_ticket_number(p_account_id UUID)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_number BIGINT;
BEGIN
  INSERT INTO internal_ticket_counters (account_id, next_number)
  VALUES (p_account_id, 2)
  ON CONFLICT (account_id) DO UPDATE
    SET next_number = internal_ticket_counters.next_number + 1,
        updated_at  = now()
  RETURNING next_number - 1 INTO v_number;

  RETURN v_number;
END;
$$;

ALTER FUNCTION public.allocate_internal_ticket_number(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.allocate_internal_ticket_number(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- ---- 2.3 internal_tickets_validate_tenancy() -------------------------
-- Um único trigger cobrindo as sete referências simples (não-compostas)
-- de internal_tickets: type_id/status_id/stage_id/team_id/
-- internal_company_id (mesma account), assigned_user_id (mesma
-- account E profiles.is_active) e created_by (mesma account E
-- profiles.is_active — HARDENING desta revisão: a checagem anterior
-- cobria assigned_user_id mas deixava created_by sem nenhuma validação
-- de tenancy no banco, mesmo criador sendo um campo de auditoria tão
-- sensível quanto o responsável). Mesmo padrão de
-- tickets_validate_tenancy (040): só levanta exceção quando a linha
-- referenciada EXISTE e diverge — "não encontrado" continua sendo
-- responsabilidade do FK puro.
--
-- Deliberadamente NÃO exige que type/status/stage/team/company
-- estejam com is_active=true — um chamado já aberto com um tipo que
-- foi desativado depois deve continuar exibindo esse tipo
-- normalmente (preservar histórico mesmo que o item de catálogo seja
-- desativado). A UI é quem deve impedir ESCOLHER um item inativo em
-- um chamado NOVO — não é uma regra de integridade do banco.
--
-- created_by só é checado em INSERT (TG_OP): a coluna é imutável desde
-- o hardening anterior (2.10, prevent_system_column_change), então não
-- há UPDATE legítimo de created_by para revalidar — checar de novo em
-- todo UPDATE de type_id/status_id/etc seria trabalho redundante sem
-- nenhum ganho (o valor nunca muda depois do INSERT).
--
-- LIMPEZA (esta revisão): "account_id" removido da lista `UPDATE OF`
-- do trigger abaixo — desde o hardening anterior, account_id também é
-- imutável (2.10), e prevent_system_column_change roda ANTES deste
-- trigger (ordem alfabética: "prevent_..." < "validate_...") e já
-- barra qualquer UPDATE que toque account_id. Mantê-lo na lista aqui
-- seria código morto: este trigger nunca chegaria a observar um
-- account_id realmente diferente de OLD.account_id.
CREATE OR REPLACE FUNCTION public.internal_tickets_validate_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type_account    UUID;
  v_status_account  UUID;
  v_stage_account   UUID;
  v_team_account    UUID;
  v_company_account UUID;
  v_assignee_account UUID;
  v_assignee_active  BOOLEAN;
  v_creator_account  UUID;
  v_creator_active   BOOLEAN;
BEGIN
  SELECT account_id INTO v_type_account FROM internal_ticket_types WHERE id = NEW.type_id;
  IF v_type_account IS NOT NULL AND v_type_account <> NEW.account_id THEN
    RAISE EXCEPTION 'internal_tickets.type_id must reference a type in the same account';
  END IF;

  SELECT account_id INTO v_status_account FROM internal_ticket_statuses WHERE id = NEW.status_id;
  IF v_status_account IS NOT NULL AND v_status_account <> NEW.account_id THEN
    RAISE EXCEPTION 'internal_tickets.status_id must reference a status in the same account';
  END IF;

  IF NEW.stage_id IS NOT NULL THEN
    SELECT account_id INTO v_stage_account FROM internal_ticket_stages WHERE id = NEW.stage_id;
    IF v_stage_account IS NOT NULL AND v_stage_account <> NEW.account_id THEN
      RAISE EXCEPTION 'internal_tickets.stage_id must reference a stage in the same account';
    END IF;
  END IF;

  IF NEW.team_id IS NOT NULL THEN
    SELECT account_id INTO v_team_account FROM internal_teams WHERE id = NEW.team_id;
    IF v_team_account IS NOT NULL AND v_team_account <> NEW.account_id THEN
      RAISE EXCEPTION 'internal_tickets.team_id must reference a team in the same account';
    END IF;
  END IF;

  IF NEW.internal_company_id IS NOT NULL THEN
    SELECT account_id INTO v_company_account FROM internal_companies WHERE id = NEW.internal_company_id;
    IF v_company_account IS NOT NULL AND v_company_account <> NEW.account_id THEN
      RAISE EXCEPTION 'internal_tickets.internal_company_id must reference a company in the same account';
    END IF;
  END IF;

  -- HARDENING (esta revisão): assigned_user_id/created_by referenciam
  -- auth.users, não profiles — a FK só garante que o auth.users existe,
  -- nunca que existe um profiles correspondente (ex.: orphan histórico
  -- do signup trigger pré-017, ver comentário em 017). O padrão antigo
  -- ("IS NOT NULL AND diverge") deixava passar silenciosamente um
  -- user_id sem NENHUM profile — nem tenancy nem atividade eram
  -- checadas nesse caso. Reescrito em 3 IFs sequenciais e explícitos:
  -- existência -> mesma account -> ativo, cada um com sua própria
  -- mensagem, para nunca confundir "não existe" com "existe em outra
  -- conta" com "existe mas inativo". Uma vez confirmada a existência
  -- (v_x_account IS NOT NULL), v_x_active nunca é NULL — is_active é
  -- NOT NULL em profiles desde 048 — então o terceiro IF não precisa
  -- de guarda extra.
  IF NEW.assigned_user_id IS NOT NULL THEN
    SELECT account_id, is_active INTO v_assignee_account, v_assignee_active
    FROM profiles WHERE user_id = NEW.assigned_user_id;
    IF v_assignee_account IS NULL THEN
      RAISE EXCEPTION 'internal_tickets.assigned_user_id must reference a profile';
    END IF;
    IF v_assignee_account <> NEW.account_id THEN
      RAISE EXCEPTION 'internal_tickets.assigned_user_id must reference a profile in the same account';
    END IF;
    IF NOT v_assignee_active THEN
      RAISE EXCEPTION 'internal_tickets.assigned_user_id must reference an active profile';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT account_id, is_active INTO v_creator_account, v_creator_active
    FROM profiles WHERE user_id = NEW.created_by;
    IF v_creator_account IS NULL THEN
      RAISE EXCEPTION 'internal_tickets.created_by must reference a profile';
    END IF;
    IF v_creator_account <> NEW.account_id THEN
      RAISE EXCEPTION 'internal_tickets.created_by must reference a profile in the same account';
    END IF;
    IF NOT v_creator_active THEN
      RAISE EXCEPTION 'internal_tickets.created_by must reference an active profile';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.internal_tickets_validate_tenancy() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.internal_tickets_validate_tenancy() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS validate_tenancy ON internal_tickets;
CREATE TRIGGER validate_tenancy
  BEFORE INSERT OR UPDATE OF type_id, status_id, stage_id, team_id, internal_company_id, assigned_user_id
  ON internal_tickets
  FOR EACH ROW EXECUTE FUNCTION public.internal_tickets_validate_tenancy();

-- ---- 2.4 internal_ticket_comments_validate_tenancy() -----------------
-- Mesmo padrão de ticket_events_validate_tenancy (040): confirma que
-- ticket_id pertence à mesma account do próprio comentário.
--
-- Histórico: a revisão anterior tinha vinculado este trigger também a
-- UPDATE OF ticket_id, account_id (não só INSERT), porque naquele
-- momento nada impedia um UPDATE de repontar ticket_id/account_id.
-- HARDENING (revisão anterior): ticket_id e account_id agora são
-- IMUTÁVEIS por construção (2.10, prevent_system_column_change), que
-- roda ANTES deste trigger e já barra qualquer UPDATE que toque essas
-- colunas — por isso o binding continua BEFORE INSERT only para elas.
--
-- HARDENING (esta revisão): duas checagens novas —
--   - author_id: mesma account E profiles.is_active, só em INSERT
--     (author_id também é imutável desde 2.10 — nada a revalidar
--     depois). Sem isso, nada no banco impedia autoria cross-tenant;
--     só a RLS de INSERT (author_id = auth.uid()) protegia, e só
--     contra o próprio usuário logado — nunca contra um caller
--     SECURITY DEFINER/service_role futuro passando um author_id
--     arbitrário.
--   - deleted_by: mesma account E profiles.is_active NO MOMENTO do
--     soft-delete. Diferente de author_id, deleted_by É mutável (nasce
--     NULL, é setado depois via UPDATE pela policy de soft-delete) —
--     por isso o trigger volta a ouvir UPDATE, mas só de
--     `deleted_by` (nunca ticket_id/account_id, que continuam cobertos
--     pelo guard de imutabilidade). TG_OP distingue os dois casos
--     explicitamente para nunca referenciar OLD durante um INSERT
--     (não existe OLD nesse contexto — referenciá-lo incondicionalmente
--     daria erro em tempo de execução).
CREATE OR REPLACE FUNCTION public.internal_ticket_comments_validate_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket_account    UUID;
  v_author_account    UUID;
  v_author_active     BOOLEAN;
  v_deleter_account   UUID;
  v_deleter_active    BOOLEAN;
  v_check_deleted_by  BOOLEAN := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT account_id INTO v_ticket_account FROM internal_tickets WHERE id = NEW.ticket_id;
    IF v_ticket_account IS NOT NULL AND v_ticket_account <> NEW.account_id THEN
      RAISE EXCEPTION 'internal_ticket_comments.ticket_id must reference a ticket in the same account';
    END IF;

    -- HARDENING (esta revisão): author_id referencia auth.users, não
    -- profiles — a FK só garante o auth.users, nunca o profile
    -- correspondente. Existência checada explicitamente antes de
    -- account/active (mesmo motivo documentado em
    -- internal_tickets_validate_tenancy, 2.3).
    SELECT account_id, is_active INTO v_author_account, v_author_active
    FROM profiles WHERE user_id = NEW.author_id;
    IF v_author_account IS NULL THEN
      RAISE EXCEPTION 'internal_ticket_comments.author_id must reference a profile';
    END IF;
    IF v_author_account <> NEW.account_id THEN
      RAISE EXCEPTION 'internal_ticket_comments.author_id must reference a profile in the same account';
    END IF;
    IF NOT v_author_active THEN
      RAISE EXCEPTION 'internal_ticket_comments.author_id must reference an active profile';
    END IF;

    v_check_deleted_by := NEW.deleted_by IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_check_deleted_by := NEW.deleted_by IS NOT NULL AND NEW.deleted_by IS DISTINCT FROM OLD.deleted_by;
  END IF;

  IF v_check_deleted_by THEN
    SELECT account_id, is_active INTO v_deleter_account, v_deleter_active
    FROM profiles WHERE user_id = NEW.deleted_by;
    IF v_deleter_account IS NULL THEN
      RAISE EXCEPTION 'internal_ticket_comments.deleted_by must reference a profile';
    END IF;
    IF v_deleter_account <> NEW.account_id THEN
      RAISE EXCEPTION 'internal_ticket_comments.deleted_by must reference a profile in the same account';
    END IF;
    IF NOT v_deleter_active THEN
      RAISE EXCEPTION 'internal_ticket_comments.deleted_by must reference an active profile';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.internal_ticket_comments_validate_tenancy() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.internal_ticket_comments_validate_tenancy() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS validate_tenancy ON internal_ticket_comments;
CREATE TRIGGER validate_tenancy
  BEFORE INSERT OR UPDATE OF deleted_by ON internal_ticket_comments
  FOR EACH ROW EXECUTE FUNCTION public.internal_ticket_comments_validate_tenancy();

-- ---- 2.5 internal_ticket_events_validate_tenancy() --------------------
-- Mesma checagem, para internal_ticket_events. Nada insere nesta
-- tabela ainda (sem policy de INSERT para cliente, sem RPC própria
-- criada nesta fase) — o trigger é posto agora como defesa em
-- profundidade para quando 052-INT-C/F passarem a escrever aqui.
--
-- HARDENING (revisão anterior): actor_user_id agora também é validado
-- contra a mesma account. DECISÃO EXPLÍCITA sobre exigir ou não
-- profiles.is_active: NÃO exigido, deliberadamente — ao contrário de
-- created_by/author_id (que fazem uma alegação PRESENTE, "este perfil
-- é o dono/autor disto agora", no exato momento do INSERT), actor_
-- user_id é puramente um registro HISTÓRICO de "quem fez esta ação
-- quando ela aconteceu" — mesmo raciocínio já aplicado acima para
-- type_id/status_id/stage_id/team_id/internal_company_id não exigirem
-- is_active=true. Exigir ativo aqui destruiria a capacidade de
-- preservar histórico: um evento não pode deixar de existir (ou passar
-- a ser rejeitado num INSERT futuro) só porque o usuário que praticou
-- a ação foi desativado depois — inclusive no caso comum de o próprio
-- evento registrar a consequência da desativação de outro usuário.
-- Mesma account continua obrigatório sempre (isso não é sobre
-- histórico, é sobre isolamento multitenant, que nunca é relaxado).
--
-- HARDENING (esta revisão): actor_user_id agora também exige que o
-- profile EXISTA — a FK é para auth.users, não para profiles, então
-- não cobria um user_id sem profile correspondente (mesmo gap
-- corrigido em assigned_user_id/created_by/author_id/deleted_by).
-- Existência é sobre tenancy (consigo saber de qual account é essa
-- pessoa?), não sobre atividade — por isso continua exigida mesmo
-- aqui, sem contradizer a decisão de não exigir is_active acima.
CREATE OR REPLACE FUNCTION public.internal_ticket_events_validate_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket_account UUID;
  v_actor_account  UUID;
BEGIN
  SELECT account_id INTO v_ticket_account FROM internal_tickets WHERE id = NEW.ticket_id;
  IF v_ticket_account IS NOT NULL AND v_ticket_account <> NEW.account_id THEN
    RAISE EXCEPTION 'internal_ticket_events.ticket_id must reference a ticket in the same account';
  END IF;

  IF NEW.actor_user_id IS NOT NULL THEN
    SELECT account_id INTO v_actor_account FROM profiles WHERE user_id = NEW.actor_user_id;
    IF v_actor_account IS NULL THEN
      RAISE EXCEPTION 'internal_ticket_events.actor_user_id must reference a profile';
    END IF;
    IF v_actor_account <> NEW.account_id THEN
      RAISE EXCEPTION 'internal_ticket_events.actor_user_id must reference a profile in the same account';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.internal_ticket_events_validate_tenancy() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.internal_ticket_events_validate_tenancy() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS validate_tenancy ON internal_ticket_events;
CREATE TRIGGER validate_tenancy
  BEFORE INSERT ON internal_ticket_events
  FOR EACH ROW EXECUTE FUNCTION public.internal_ticket_events_validate_tenancy();

-- ---- 2.6 internal_team_members_validate_active() ----------------------
-- AJUSTE EXTRA 1: a FK composta acima já garante "mesma account" — não
-- garante "usuário ativo". Este trigger bloqueia criar (ou reativar,
-- via UPDATE) uma membership ATIVA para um profile que não está
-- is_active. Uma membership já existente e INATIVA nunca é tocada por
-- este trigger — histórico físico nunca é apagado.
CREATE OR REPLACE FUNCTION public.internal_team_members_validate_active()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile_active BOOLEAN;
BEGIN
  IF NEW.is_active THEN
    SELECT is_active INTO v_profile_active FROM profiles WHERE user_id = NEW.user_id;
    IF v_profile_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'internal_team_members.user_id must reference an active profile to become an active member';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.internal_team_members_validate_active() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.internal_team_members_validate_active() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS validate_active ON internal_team_members;
CREATE TRIGGER validate_active
  BEFORE INSERT OR UPDATE OF user_id, is_active ON internal_team_members
  FOR EACH ROW EXECUTE FUNCTION public.internal_team_members_validate_active();

-- ---- 2.7 internal_tickets_handle_profile_deactivation() ---------------
-- AJUSTE EXTRA 1 + item 5: quando um profile passa de is_active=true
-- para false, (a) toda internal_team_members ATIVA desse usuário vira
-- inativa (nunca apagada — só deixa de contar para visibilidade/
-- elegibilidade), e (b) todo internal_tickets.assigned_user_id
-- apontando para ele é zerado. Status/etapa/equipe do chamado NUNCA
-- são alterados automaticamente — só o campo de responsável.
--
-- Trigger NOVO e independente em `profiles`, ao lado (não em
-- substituição) de profiles_clear_primary_agent_on_deactivation()
-- (051) — múltiplos triggers AFTER UPDATE no mesmo evento convivem
-- normalmente no Postgres; nenhum dos dois é alterado.
CREATE OR REPLACE FUNCTION public.internal_tickets_handle_profile_deactivation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_active = false AND OLD.is_active = true THEN
    UPDATE internal_team_members
    SET is_active = false, updated_at = now()
    WHERE user_id = NEW.user_id AND is_active = true;

    UPDATE internal_tickets
    SET assigned_user_id = NULL, updated_at = now()
    WHERE assigned_user_id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.internal_tickets_handle_profile_deactivation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.internal_tickets_handle_profile_deactivation() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS internal_tickets_handle_profile_deactivation ON profiles;
CREATE TRIGGER internal_tickets_handle_profile_deactivation
  AFTER UPDATE OF is_active ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.internal_tickets_handle_profile_deactivation();

-- ---- 2.8 seed_internal_ticket_defaults_for_account(p_account_id) ------
-- Helper compartilhado pelo backfill (seção 4) e pelo trigger de conta
-- nova (2.9) — única fonte de verdade para "quais são os defaults",
-- nunca duplicada. ON CONFLICT DO NOTHING em cima do UNIQUE(account_id,
-- name) de cada catálogo torna a função idempotente por construção:
-- rodar de novo para a mesma account nunca duplica nem sobrescreve
-- uma linha já renomeada/reordenada pelo usuário.
--
-- BUG CORRIGIDO NESTA REVISÃO — status/stage e o índice único parcial
-- de is_default: a versão anterior inseria a linha default (ex.: 'Em
-- andamento', is_default=true) com `ON CONFLICT (account_id, name) DO
-- NOTHING`. Isso só protege contra reinserir a MESMA linha pelo MESMO
-- nome — se o usuário renomeia o default (ex.: 'Em andamento' ->
-- 'Aberto', mantendo is_default=true) e o seed roda de novo (backfill
-- reaplicado, ou uma conta processada duas vezes), o nome 'Em
-- andamento' não colide mais com nada, então o INSERT tenta seguir em
-- frente como linha NOVA — e colide com
-- idx_internal_ticket_statuses_one_default /
-- idx_internal_ticket_stages_one_default (índice único parcial:
-- no máximo um is_default=true por account), um constraint DIFERENTE
-- do que o `ON CONFLICT (account_id, name)` está escutando. Postgres
-- só absorve silenciosamente o conflito no arbiter exato declarado no
-- ON CONFLICT — a violação do OUTRO índice não é coberta e sobe como
-- erro, derrubando a chamada inteira (o trigger de accounts para conta
-- nova, ou o backfill inteiro da seção 4).
--
-- CORREÇÃO: para status/stage, a linha default só é inserida SE a
-- account ainda não tiver NENHUM is_default=true (`WHERE NOT EXISTS`)
-- — cobre tanto "nunca seedado" quanto "default foi renomeado mas
-- continua marcado como default" (nesse caso o INSERT sequer é
-- tentado: já existe um is_default=true, então nunca há conflito
-- nenhum, do índice parcial nem do nome). As demais linhas do mesmo
-- catálogo são inseridas SEMPRE com is_default=false, então nunca
-- disputam o índice parcial em nenhuma execução.
CREATE OR REPLACE FUNCTION public.seed_internal_ticket_defaults_for_account(p_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- types/teams: sem coluna is_default, então sem o risco de violação
  -- de índice parcial acima — o único ponto em aberto é cosmético, não
  -- uma falha. Documentado aqui, deliberadamente NÃO resolvido com uma
  -- chave estável (default_key): se o usuário renomear 'Suporte TI'
  -- para outro nome e o seed rodar de novo para a MESMA account (só
  -- acontece hoje se este arquivo de migration for reaplicado depois
  -- de contas já terem sido editadas — não é o fluxo normal de
  -- produção, onde cada migration roda exatamente uma vez), o nome
  -- original 'Suporte TI'/'Fiscal'/'Diretoria' reaparece como uma
  -- linha NOVA ao lado da renomeada pelo usuário — duplicata
  -- cosmética, nunca um erro/exceção (UNIQUE(account_id,name) só
  -- rejeitaria se o nome ainda existisse; como foi renomeado, não
  -- existe mais, então a nova linha entra livremente). Introduzir uma
  -- chave estável exigiria coluna nova + índice novo só para um
  -- cenário que não ocorre no fluxo real deste projeto (migrations não
  -- são reaplicadas em produção após seu primeiro apply) — complexidade
  -- desproporcional ao risco real; revisitar se esse padrão de reaplicar
  -- migrations mudar.
  INSERT INTO internal_ticket_types (account_id, name, sort_order)
  VALUES
    (p_account_id, 'Suporte TI', 0),
    (p_account_id, 'Fiscal', 1),
    (p_account_id, 'Diretoria', 2),
    (p_account_id, 'Ajuste', 3),
    (p_account_id, 'Cobrança', 4),
    (p_account_id, 'Revisão de documentos', 5),
    (p_account_id, 'Pendências Leonardo', 6)
  ON CONFLICT (account_id, name) DO NOTHING;

  -- status: a linha default só entra se a account ainda não tem
  -- NENHUM is_default=true — nunca disputa o índice parcial.
  INSERT INTO internal_ticket_statuses (account_id, name, sort_order, is_terminal, is_default)
  SELECT p_account_id, 'Em andamento', 0, false, true
  WHERE NOT EXISTS (
    SELECT 1 FROM internal_ticket_statuses WHERE account_id = p_account_id AND is_default
  )
  ON CONFLICT (account_id, name) DO NOTHING;

  -- Demais status: sempre is_default=false — jamais disputam o
  -- índice parcial, em nenhuma execução.
  INSERT INTO internal_ticket_statuses (account_id, name, sort_order, is_terminal, is_default)
  VALUES
    (p_account_id, 'Em análise', 1, false, false),
    (p_account_id, 'Finalizado', 2, true, false),
    (p_account_id, 'Concluído', 3, true, false),
    (p_account_id, 'Cancelado', 4, true, false)
  ON CONFLICT (account_id, name) DO NOTHING;

  -- stage: mesmo padrão de status acima.
  INSERT INTO internal_ticket_stages (account_id, name, sort_order, is_terminal, is_default)
  SELECT p_account_id, 'Solicitação', 0, false, true
  WHERE NOT EXISTS (
    SELECT 1 FROM internal_ticket_stages WHERE account_id = p_account_id AND is_default
  )
  ON CONFLICT (account_id, name) DO NOTHING;

  INSERT INTO internal_ticket_stages (account_id, name, sort_order, is_terminal, is_default)
  VALUES
    (p_account_id, 'Em análise', 1, false, false),
    (p_account_id, 'Encerrado', 2, true, false)
  ON CONFLICT (account_id, name) DO NOTHING;

  INSERT INTO internal_teams (account_id, name, sort_order)
  VALUES
    (p_account_id, 'Fiscal', 0),
    (p_account_id, 'Suporte TI', 1),
    (p_account_id, 'Diretoria', 2)
  ON CONFLICT (account_id, name) DO NOTHING;

  -- internal_companies: sem seed, de propósito — ver comentário na
  -- criação da tabela.
END;
$$;

ALTER FUNCTION public.seed_internal_ticket_defaults_for_account(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.seed_internal_ticket_defaults_for_account(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- ---- 2.9 seed_internal_ticket_defaults() (trigger em accounts) --------
-- AJUSTE 7: trigger NOVO, independente, em `accounts` — não toca
-- handle_new_user() nem platform_create_account(), não altera nenhum
-- outro dado da conta. Só insere linhas nos catálogos de Chamados
-- Internos para a conta recém-criada.
CREATE OR REPLACE FUNCTION public.seed_internal_ticket_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.seed_internal_ticket_defaults_for_account(NEW.id);
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.seed_internal_ticket_defaults() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.seed_internal_ticket_defaults() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS seed_internal_ticket_defaults ON accounts;
CREATE TRIGGER seed_internal_ticket_defaults
  AFTER INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.seed_internal_ticket_defaults();

-- ---- 2.10 internal_prevent_immutable_column_change() (HARDENING) ------
-- AJUSTE EXTRA 3 (hardening pós-revisão A–J): campos de identidade/
-- sistema nunca devem mudar depois do INSERT — nem "mover" uma linha
-- para outra account (mesmo que o chamador seja membro das duas, ou
-- seja service_role/console), nem trocar quem criou/assinou algo, nem
-- reescrever a chave primária ou o timestamp de criação.
--
-- ESCOLHA DE DESENHO: um único trigger genérico e reutilizável, em vez
-- de uma função específica por tabela/coluna. A função lê a lista de
-- colunas protegidas dos argumentos do próprio CREATE TRIGGER
-- (TG_ARGV) e compara OLD vs NEW via to_jsonb(...)->>coluna — sem SQL
-- dinâmico (nenhum EXECUTE/format sobre nomes de tabela/coluna vindos
-- de input externo; TG_ARGV é fixo, definido em CADA CREATE TRIGGER
-- deste arquivo, nunca vindo do chamador em runtime), então não há
-- superfície de injeção. Uma função só, nove triggers (um por tabela,
-- cada um com a lista de colunas que faz sentido para aquela tabela),
-- em vez de 9 funções quase idênticas — mesmo espírito de reuso já
-- aplicado a *_validate_tenancy acima.
--
-- DIFERENÇA DELIBERADA do padrão de enforce_profile_privilege_columns
-- (034) / a checagem de account_id em profiles: aquele trigger só
-- bloqueia o role `authenticated` (current_user = 'authenticated'),
-- porque profiles.account_id TEM caminhos legítimos de mutação via
-- RPC SECURITY DEFINER (set_member_role, redeem_invitation,
-- platform_attach_user_to_account, etc. — todos rodam como postgres).
-- Nas 9 tabelas internal_* abaixo, ao contrário, NENHUM código deste
-- projeto — hoje ou planejado — precisa legitimamente trocar
-- id/account_id/created_by/created_at/internal_code/author_id/
-- ticket_id de uma linha já criada; a única forma correta de "mudar
-- de conta" é apagar e recriar. Por isso este guard é INCONDICIONAL
-- (não olha current_user/role nenhum) — bloqueia até postgres/
-- SECURITY DEFINER/service_role. Se uma fase futura precisar
-- genuinamente de uma exceção pontual, o caminho correto é uma nova
-- migration que relaxe ESSA coluna explicitamente, com a mesma
-- documentação que 034 já dá ao caso análogo — nunca um bypass
-- silencioso aqui.
--
-- SECURITY DEFINER/OWNER/search_path/REVOKE mantidos só por
-- consistência de estilo com as outras funções deste arquivo — a
-- função em si não lê nenhuma tabela além de OLD/NEW, não precisa de
-- privilégio elevado para funcionar.
CREATE OR REPLACE FUNCTION public.internal_prevent_immutable_column_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_json JSONB := to_jsonb(OLD);
  v_new_json JSONB := to_jsonb(NEW);
  v_col TEXT;
  i INT;
BEGIN
  FOR i IN 0 .. TG_NARGS - 1 LOOP
    v_col := TG_ARGV[i];
    IF (v_new_json ->> v_col) IS DISTINCT FROM (v_old_json ->> v_col) THEN
      RAISE EXCEPTION '%.% cannot be changed after creation', TG_TABLE_NAME, v_col
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.internal_prevent_immutable_column_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.internal_prevent_immutable_column_change() FROM PUBLIC, anon, authenticated, service_role;

-- Catálogos: id/account_id/created_at imutáveis. Colunas de negócio
-- (name/is_active/sort_order/is_terminal/is_default/color/description)
-- continuam livremente editáveis por admin+, como já era.
DROP TRIGGER IF EXISTS prevent_system_column_change ON internal_ticket_types;
CREATE TRIGGER prevent_system_column_change
  BEFORE UPDATE OF id, account_id, created_at ON internal_ticket_types
  FOR EACH ROW EXECUTE FUNCTION public.internal_prevent_immutable_column_change('id', 'account_id', 'created_at');

DROP TRIGGER IF EXISTS prevent_system_column_change ON internal_ticket_statuses;
CREATE TRIGGER prevent_system_column_change
  BEFORE UPDATE OF id, account_id, created_at ON internal_ticket_statuses
  FOR EACH ROW EXECUTE FUNCTION public.internal_prevent_immutable_column_change('id', 'account_id', 'created_at');

DROP TRIGGER IF EXISTS prevent_system_column_change ON internal_ticket_stages;
CREATE TRIGGER prevent_system_column_change
  BEFORE UPDATE OF id, account_id, created_at ON internal_ticket_stages
  FOR EACH ROW EXECUTE FUNCTION public.internal_prevent_immutable_column_change('id', 'account_id', 'created_at');

DROP TRIGGER IF EXISTS prevent_system_column_change ON internal_companies;
CREATE TRIGGER prevent_system_column_change
  BEFORE UPDATE OF id, account_id, created_at ON internal_companies
  FOR EACH ROW EXECUTE FUNCTION public.internal_prevent_immutable_column_change('id', 'account_id', 'created_at');

DROP TRIGGER IF EXISTS prevent_system_column_change ON internal_teams;
CREATE TRIGGER prevent_system_column_change
  BEFORE UPDATE OF id, account_id, created_at ON internal_teams
  FOR EACH ROW EXECUTE FUNCTION public.internal_prevent_immutable_column_change('id', 'account_id', 'created_at');

-- internal_team_members: id/account_id/team_id/user_id/created_at
-- imutáveis.
--
-- CORREÇÃO (esta revisão): team_id/user_id ENTRAM na lista — decisão
-- de produto fechada: internal_team_members preserva histórico real de
-- participação (mesmo espírito da remoção do DELETE físico, seção
-- 3.2), então a IDENTIDADE de uma membership (de qual time, de qual
-- pessoa) não pode ser repontada depois de criada, só a passagem
-- ativo/inativo. Antes desta revisão, team_id/user_id ficavam de fora
-- por serem tratados como decisão de produto ainda em aberto — não
-- estão mais em aberto.
--
-- Regra operacional (não é enforced em código, é o processo correto):
-- mover uma pessoa de equipe = (1) UPDATE da membership antiga SET
-- is_active = false, (2) INSERT de uma membership NOVA para a nova
-- equipe. Substituir quem ocupa uma "vaga" numa equipe segue a mesma
-- lógica — nunca reaproveitar/repontar a linha existente. is_active
-- continua livremente mutável (é o único mecanismo de entrada/saída,
-- como já era).
DROP TRIGGER IF EXISTS prevent_system_column_change ON internal_team_members;
CREATE TRIGGER prevent_system_column_change
  BEFORE UPDATE OF id, account_id, team_id, user_id, created_at ON internal_team_members
  FOR EACH ROW EXECUTE FUNCTION public.internal_prevent_immutable_column_change(
    'id', 'account_id', 'team_id', 'user_id', 'created_at'
  );

-- internal_tickets: id/account_id/internal_code/created_by/created_at
-- imutáveis — exatamente os 5 "campos de sistema" da seção 5 da
-- revisão. assigned_user_id continua livremente editável (nunca
-- confundir com created_by); title/description/type_id/status_id/
-- stage_id/team_id/internal_company_id/scheduled_at/completed_at/
-- cancelled_at/cancel_reason também continuam editáveis — este guard
-- não os toca. updated_at não precisa entrar aqui: o trigger
-- set_updated_at (2.1) já sobrescreve incondicionalmente qualquer
-- valor que o cliente tentar enviar.
DROP TRIGGER IF EXISTS prevent_system_column_change ON internal_tickets;
CREATE TRIGGER prevent_system_column_change
  BEFORE UPDATE OF id, account_id, internal_code, created_by, created_at ON internal_tickets
  FOR EACH ROW EXECUTE FUNCTION public.internal_prevent_immutable_column_change(
    'id', 'account_id', 'internal_code', 'created_by', 'created_at'
  );

-- internal_ticket_comments: id/account_id/ticket_id/author_id/
-- created_at imutáveis — um comentário nunca muda de ticket nem de
-- autor depois de criado (preferência explícita da revisão). Edição
-- continua limitada, na prática, a body/deleted_at/deleted_by, que a
-- policy internal_ticket_comments_update (3.4) já governa; nada aqui
-- impede body de mudar.
DROP TRIGGER IF EXISTS prevent_system_column_change ON internal_ticket_comments;
CREATE TRIGGER prevent_system_column_change
  BEFORE UPDATE OF id, account_id, ticket_id, author_id, created_at ON internal_ticket_comments
  FOR EACH ROW EXECUTE FUNCTION public.internal_prevent_immutable_column_change(
    'id', 'account_id', 'ticket_id', 'author_id', 'created_at'
  );

-- internal_ticket_events: id/account_id/created_at imutáveis. Defesa
-- em profundidade, não uma lacuna de RLS real — a tabela já não tem
-- NENHUMA policy de UPDATE para authenticated (seção 3.5), então este
-- guard só importa para um caller que já bypassa RLS (service_role/
-- console), fechando exatamente esse caso residual.
DROP TRIGGER IF EXISTS prevent_system_column_change ON internal_ticket_events;
CREATE TRIGGER prevent_system_column_change
  BEFORE UPDATE OF id, account_id, created_at ON internal_ticket_events
  FOR EACH ROW EXECUTE FUNCTION public.internal_prevent_immutable_column_change('id', 'account_id', 'created_at');

-- ============================================================
-- 3. RLS
-- ============================================================

ALTER TABLE internal_ticket_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_ticket_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_ticket_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_ticket_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_ticket_events ENABLE ROW LEVEL SECURITY;

-- ---- 3.1 Catálogos (types/statuses/stages/companies/teams) -----------
-- Qualquer membro da conta lê; só admin+ escreve (is_account_member já
-- inclui owner via rank >= 3 — ver PARTE E do relatório). Sem policy
-- de DELETE em nenhum — arquivar via is_active, nunca apagar
-- fisicamente (impede excluir configuração já em uso sem precisar de
-- um CHECK extra: RLS default-deny já bloqueia DELETE por completo
-- para authenticated).
DROP POLICY IF EXISTS internal_ticket_types_select ON internal_ticket_types;
DROP POLICY IF EXISTS internal_ticket_types_insert ON internal_ticket_types;
DROP POLICY IF EXISTS internal_ticket_types_update ON internal_ticket_types;
CREATE POLICY internal_ticket_types_select ON internal_ticket_types FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY internal_ticket_types_insert ON internal_ticket_types FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY internal_ticket_types_update ON internal_ticket_types FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS internal_ticket_statuses_select ON internal_ticket_statuses;
DROP POLICY IF EXISTS internal_ticket_statuses_insert ON internal_ticket_statuses;
DROP POLICY IF EXISTS internal_ticket_statuses_update ON internal_ticket_statuses;
CREATE POLICY internal_ticket_statuses_select ON internal_ticket_statuses FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY internal_ticket_statuses_insert ON internal_ticket_statuses FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY internal_ticket_statuses_update ON internal_ticket_statuses FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS internal_ticket_stages_select ON internal_ticket_stages;
DROP POLICY IF EXISTS internal_ticket_stages_insert ON internal_ticket_stages;
DROP POLICY IF EXISTS internal_ticket_stages_update ON internal_ticket_stages;
CREATE POLICY internal_ticket_stages_select ON internal_ticket_stages FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY internal_ticket_stages_insert ON internal_ticket_stages FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY internal_ticket_stages_update ON internal_ticket_stages FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS internal_companies_select ON internal_companies;
DROP POLICY IF EXISTS internal_companies_insert ON internal_companies;
DROP POLICY IF EXISTS internal_companies_update ON internal_companies;
CREATE POLICY internal_companies_select ON internal_companies FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY internal_companies_insert ON internal_companies FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY internal_companies_update ON internal_companies FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS internal_teams_select ON internal_teams;
DROP POLICY IF EXISTS internal_teams_insert ON internal_teams;
DROP POLICY IF EXISTS internal_teams_update ON internal_teams;
CREATE POLICY internal_teams_select ON internal_teams FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY internal_teams_insert ON internal_teams FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY internal_teams_update ON internal_teams FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ---- 3.2 internal_team_members ----------------------------------------
-- Leitura para qualquer membro, escrita (INSERT/UPDATE) só admin+.
--
-- CORREÇÃO (esta revisão): DELETE físico REMOVIDO. A versão anterior
-- desta migration seguia o recorte de queue_members (039), que permite
-- DELETE por admin+ — mas a decisão de produto para este módulo é
-- diferente: histórico de participação em equipes é preservado sempre,
-- entrada/saída é só is_active=true/false (mesmo mecanismo já usado
-- para desativação automática via internal_tickets_handle_profile_
-- deactivation, 2.7). Sem policy de DELETE nenhuma para
-- `authenticated`, RLS default-deny bloqueia por completo — mesmo
-- padrão já usado pelos 5 catálogos (types/statuses/stages/companies/
-- teams) na seção 3.1. A partir desta revisão, NENHUMA tabela
-- internal_* de configuração/membership tem DELETE físico pelo
-- cliente, sem exceção.
DROP POLICY IF EXISTS internal_team_members_select ON internal_team_members;
DROP POLICY IF EXISTS internal_team_members_insert ON internal_team_members;
DROP POLICY IF EXISTS internal_team_members_update ON internal_team_members;
DROP POLICY IF EXISTS internal_team_members_delete ON internal_team_members;
CREATE POLICY internal_team_members_select ON internal_team_members FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY internal_team_members_insert ON internal_team_members FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY internal_team_members_update ON internal_team_members FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
-- Sem policy de DELETE — physical deletion por `authenticated` é
-- impossível por construção (RLS default-deny). O DROP POLICY IF
-- EXISTS acima permanece (idempotência padrão do arquivo: remove a
-- policy caso já tenha sido criada por uma execução anterior desta
-- mesma migration, antes desta correção).

-- ---- 3.3 internal_tickets ----------------------------------------------
-- AJUSTE 6 — princípio de menor privilégio: só admin/owner veem TODOS
-- os chamados da conta. agent E viewer só veem chamados em que estão
-- diretamente envolvidos (criador, responsável, ou membro ATIVO da
-- equipe atual) — mesma regra para os dois papéis, escrita uma única
-- vez via is_account_member(account_id) sem exigir rank mínimo além de
-- "ser membro" (agent e viewer satisfazem igualmente). O schema não
-- impede um profile viewer de ser created_by/assigned_user_id (não há
-- CHECK de papel nessas colunas), então a condição de envolvimento
-- funciona igual para os dois sem precisar de tratamento especial.
--
-- Sem policy de INSERT: criação só via RPC futura (052-INT-C), que vai
-- rodar SECURITY DEFINER e não depende de policy nenhuma aqui.
--
-- UPDATE exige rank agent (exclui viewer mesmo que esteja envolvido,
-- por instrução explícita "viewer: somente leitura").
--
-- AUDITORIA USING/WITH CHECK (hardening pós A–J): WITH CHECK repete
-- EXATAMENTE a mesma condição de envolvimento do USING, avaliada
-- contra a linha NOVA — um agent não consegue usar um UPDATE para
-- sair da própria regra de elegibilidade (ex.: trocar team_id para um
-- time do qual não é membro ativo derruba o WITH CHECK, porque
-- `internal_team_members tm WHERE tm.team_id = internal_tickets.team_id`
-- dentro do WITH CHECK lê o team_id NOVO, não o antigo). Autorização
-- (quem pode tocar a linha) fica inteira na RLS; integridade de
-- tenancy (os id's de catálogo/assignee realmente pertencem a esta
-- account) fica inteira no trigger validate_tenancy (2.3) — as duas
-- camadas não se sobrepõem nem duplicam lógica uma da outra. A partir
-- desta revisão, account_id também é estruturalmente imutável (2.10):
-- "a linha nova continua na mesma account" deixa de ser só uma
-- checagem de RLS e passa a ser garantido pelo próprio schema,
-- incondicionalmente, para qualquer chamador.
--
-- Sem policy de DELETE — cancelamento é campo (cancelled_at/
-- cancel_reason), nunca remoção de linha.
DROP POLICY IF EXISTS internal_tickets_select ON internal_tickets;
DROP POLICY IF EXISTS internal_tickets_update ON internal_tickets;
CREATE POLICY internal_tickets_select ON internal_tickets FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id)
      AND (
        created_by = auth.uid()
        OR assigned_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM internal_team_members tm
          WHERE tm.team_id = internal_tickets.team_id
            AND tm.account_id = internal_tickets.account_id
            AND tm.user_id = auth.uid()
            AND tm.is_active
        )
      )
    )
  );
CREATE POLICY internal_tickets_update ON internal_tickets FOR UPDATE
  USING (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND (
        created_by = auth.uid()
        OR assigned_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM internal_team_members tm
          WHERE tm.team_id = internal_tickets.team_id
            AND tm.account_id = internal_tickets.account_id
            AND tm.user_id = auth.uid()
            AND tm.is_active
        )
      )
    )
  )
  WITH CHECK (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND (
        created_by = auth.uid()
        OR assigned_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM internal_team_members tm
          WHERE tm.team_id = internal_tickets.team_id
            AND tm.account_id = internal_tickets.account_id
            AND tm.user_id = auth.uid()
            AND tm.is_active
        )
      )
    )
  );

-- ---- 3.4 internal_ticket_comments ---------------------------------------
-- Visibilidade idêntica ao ticket pai (mesmo padrão de
-- ticket_events_select repetindo a lógica de tickets_select, em vez de
-- um helper compartilhado). INSERT exige agent+ e autoria própria.
-- UPDATE (edição OU soft-delete, que é só um UPDATE marcando
-- deleted_at/deleted_by) é do próprio autor OU admin+; WITH CHECK
-- garante que deleted_by, quando setado, só pode ser o próprio
-- chamador — nunca é possível "assinar" a exclusão em nome de outra
-- pessoa.
DROP POLICY IF EXISTS internal_ticket_comments_select ON internal_ticket_comments;
DROP POLICY IF EXISTS internal_ticket_comments_insert ON internal_ticket_comments;
DROP POLICY IF EXISTS internal_ticket_comments_update ON internal_ticket_comments;
CREATE POLICY internal_ticket_comments_select ON internal_ticket_comments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM internal_tickets t
      WHERE t.id = internal_ticket_comments.ticket_id
        AND t.account_id = internal_ticket_comments.account_id
        AND (
          is_account_member(t.account_id, 'admin')
          OR (
            is_account_member(t.account_id)
            AND (
              t.created_by = auth.uid()
              OR t.assigned_user_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM internal_team_members tm
                WHERE tm.team_id = t.team_id
                  AND tm.account_id = t.account_id
                  AND tm.user_id = auth.uid()
                  AND tm.is_active
              )
            )
          )
        )
    )
  );
CREATE POLICY internal_ticket_comments_insert ON internal_ticket_comments FOR INSERT
  WITH CHECK (
    author_id = auth.uid()
    AND is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM internal_tickets t
      WHERE t.id = internal_ticket_comments.ticket_id
        AND t.account_id = internal_ticket_comments.account_id
        AND (
          is_account_member(t.account_id, 'admin')
          OR t.created_by = auth.uid()
          OR t.assigned_user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM internal_team_members tm
            WHERE tm.team_id = t.team_id
              AND tm.account_id = t.account_id
              AND tm.user_id = auth.uid()
              AND tm.is_active
          )
        )
    )
  );
CREATE POLICY internal_ticket_comments_update ON internal_ticket_comments FOR UPDATE
  USING (
    is_account_member(account_id, 'admin')
    OR (author_id = auth.uid() AND is_account_member(account_id, 'agent'))
  )
  WITH CHECK (
    (deleted_by IS NULL OR deleted_by = auth.uid())
    AND (
      is_account_member(account_id, 'admin')
      OR (author_id = auth.uid() AND is_account_member(account_id, 'agent'))
    )
  );

-- ---- 3.5 internal_ticket_events -----------------------------------------
-- Mesma visibilidade do ticket pai, sem nenhuma policy de escrita —
-- append-only via trigger/RPC futura (SECURITY DEFINER, bypassa RLS),
-- igual ticket_events.
DROP POLICY IF EXISTS internal_ticket_events_select ON internal_ticket_events;
CREATE POLICY internal_ticket_events_select ON internal_ticket_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM internal_tickets t
      WHERE t.id = internal_ticket_events.ticket_id
        AND t.account_id = internal_ticket_events.account_id
        AND (
          is_account_member(t.account_id, 'admin')
          OR (
            is_account_member(t.account_id)
            AND (
              t.created_by = auth.uid()
              OR t.assigned_user_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM internal_team_members tm
                WHERE tm.team_id = t.team_id
                  AND tm.account_id = t.account_id
                  AND tm.user_id = auth.uid()
                  AND tm.is_active
              )
            )
          )
        )
    )
  );

-- ============================================================
-- 4. BACKFILL — contas já existentes
-- ============================================================
-- Mesma rotina do trigger (2.9), aplicada uma vez a cada account que
-- já existe hoje. Idempotente via ON CONFLICT DO NOTHING dentro de
-- seed_internal_ticket_defaults_for_account — reaplicar esta migration
-- nunca duplica nem sobrescreve linhas já editadas pelo usuário.
DO $$
DECLARE
  v_account RECORD;
BEGIN
  FOR v_account IN SELECT id FROM accounts LOOP
    PERFORM public.seed_internal_ticket_defaults_for_account(v_account.id);
  END LOOP;
END $$;

-- ============================================================
-- VALIDAÇÃO MANUAL (não existe harness de teste SQL automatizado
-- neste repositório — mesmo aviso já registrado em 034/049/050/051).
-- Rodar contra staging, nunca produção, antes/depois de aplicar.
--
-- ---- Bloco A — introspecção estrutural (somente leitura, seguro
--      rodar a qualquer momento, inclusive em produção) ----
--
--  1. As 10 tabelas existem:
--       SELECT count(*) FROM pg_tables WHERE schemaname = 'public'
--         AND tablename IN (
--           'internal_ticket_counters','internal_ticket_types',
--           'internal_ticket_statuses','internal_ticket_stages',
--           'internal_companies','internal_teams','internal_team_members',
--           'internal_tickets','internal_ticket_comments','internal_ticket_events'
--         );
--     Esperado: 10.
--
--  2. RLS habilitada em todas as 10:
--       SELECT tablename, rowsecurity FROM pg_tables
--       WHERE schemaname = 'public' AND tablename LIKE 'internal\_%' ESCAPE '\';
--     Esperado: rowsecurity = true em todas as 10 linhas.
--
--  3. Indexes/unique constraints esperados (checar cada um existe):
--       SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
--         AND tablename LIKE 'internal\_%' ESCAPE '\' ORDER BY 1;
--     Confirmar presentes, entre outros: idx_internal_teams_id_account
--     (UNIQUE(id,account_id) — alvo da FK composta de
--     internal_team_members), idx_internal_ticket_statuses_one_default
--     e idx_internal_ticket_stages_one_default (UNIQUE parcial WHERE
--     is_default), UNIQUE(account_id,name) em types/statuses/stages/
--     companies/teams (via \d nomeado pelo Postgres,
--     ..._account_id_name_key), UNIQUE(account_id,internal_code) em
--     internal_tickets, UNIQUE(team_id,user_id) em internal_team_members.
--
--  4. FKs corretas, incluindo as duas compostas:
--       SELECT conname, conrelid::regclass, confrelid::regclass, pg_get_constraintdef(oid)
--       FROM pg_constraint
--       WHERE contype = 'f' AND conrelid::regclass::text LIKE 'internal_%'
--       ORDER BY 1;
--     Confirmar especialmente as duas FKs compostas de
--     internal_team_members: (team_id,account_id) -> internal_teams
--     (id,account_id) e (user_id,account_id) -> profiles(user_id,account_id).
--
--  5. Funções existem (9 novas — recontado nesta revisão, incluindo
--     internal_prevent_immutable_column_change do hardening anterior,
--     que a versão prévia desta lista tinha deixado de fora):
--       SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
--         AND proname IN (
--           'allocate_internal_ticket_number','internal_tickets_validate_tenancy',
--           'internal_ticket_comments_validate_tenancy','internal_ticket_events_validate_tenancy',
--           'internal_team_members_validate_active','internal_tickets_handle_profile_deactivation',
--           'seed_internal_ticket_defaults_for_account','seed_internal_ticket_defaults',
--           'internal_prevent_immutable_column_change'
--         ) ORDER BY 1;
--     Esperado: 9 linhas.
--
--  6. SECURITY DEFINER com owner/search_path corretos, para as 9:
--       SELECT p.proname, r.rolname AS owner, p.prosecdef,
--              p.proconfig
--       FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
--       WHERE p.pronamespace = 'public'::regnamespace
--         AND p.proname IN (
--           'allocate_internal_ticket_number','internal_tickets_validate_tenancy',
--           'internal_ticket_comments_validate_tenancy','internal_ticket_events_validate_tenancy',
--           'internal_team_members_validate_active','internal_tickets_handle_profile_deactivation',
--           'seed_internal_ticket_defaults_for_account','seed_internal_ticket_defaults',
--           'internal_prevent_immutable_column_change'
--         );
--     Esperado, para as 9: owner = postgres, prosecdef = true,
--     proconfig contendo 'search_path=public'.
--
--  7. Grants — CORRIGIDO nesta revisão: nenhuma das 9 funções deve ter
--     EXECUTE para PUBLIC/anon/authenticated/service_role — as 8 que
--     antes só faziam REVOKE de PUBLIC/anon/authenticated (deixando
--     service_role de fora, confirmado na validação pós-apply) agora
--     também revogam de service_role, igualando o padrão já usado por
--     allocate_internal_ticket_number desde a fundação. A query NÃO
--     deve esperar zero linhas — `postgres` (o owner) aparece
--     normalmente em information_schema.routine_privileges com
--     EXECUTE, e isso é o comportamento correto/esperado, não uma
--     lacuna. O que precisa dar zero é o filtro por grantee:
--       SELECT p.proname, a.grantee, a.privilege_type
--       FROM information_schema.routine_privileges a
--       JOIN pg_proc p ON p.proname = a.routine_name
--       WHERE a.routine_schema = 'public'
--         AND p.proname IN (
--           'allocate_internal_ticket_number','internal_tickets_validate_tenancy',
--           'internal_ticket_comments_validate_tenancy','internal_ticket_events_validate_tenancy',
--           'internal_team_members_validate_active','internal_tickets_handle_profile_deactivation',
--           'seed_internal_ticket_defaults_for_account','seed_internal_ticket_defaults',
--           'internal_prevent_immutable_column_change'
--         )
--         AND a.grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role');
--     Esperado: zero linhas (nenhuma das 4 roles client-facing/
--     service tem EXECUTE em nenhuma das 9). Rodar a MESMA query sem o
--     filtro de grantee para conferir que `postgres` aparece com
--     EXECUTE nas 9 — isso confirma que o owner continua podendo
--     executar suas próprias funções (nunca foi, e não deveria ser,
--     revogado dele).
--
--  8. Triggers presentes (24 no total — recontado nesta revisão: 9
--     set_updated_at + 3 validate_tenancy [internal_tickets,
--     internal_ticket_comments, internal_ticket_events] + 1
--     validate_active [internal_team_members] + 1 seed em accounts +
--     1 deactivation em profiles + 9 prevent_system_column_change do
--     hardening anterior, que a contagem prévia "17" não incluía):
--       SELECT tgname, tgrelid::regclass FROM pg_trigger
--       WHERE NOT tgisinternal
--         AND (tgrelid::regclass::text LIKE 'internal_%'
--              OR tgname IN ('seed_internal_ticket_defaults',
--                             'internal_tickets_handle_profile_deactivation'))
--       ORDER BY 2, 1;
--     Esperado: 24 linhas. Confirmar especialmente que
--     internal_ticket_comments aparece com DOIS triggers de validação
--     distintos hoje: validate_tenancy (agora BEFORE INSERT OR UPDATE
--     OF deleted_by — não mais INSERT only) e prevent_system_column_
--     change (BEFORE UPDATE OF id, account_id, ticket_id, author_id,
--     created_at).
--
--  9. Defaults/seeds — para uma account de teste qualquer já existente
--     (backfill já deve ter rodado):
--       SELECT 'types', count(*) FROM internal_ticket_types WHERE account_id = '<uuid>'
--       UNION ALL SELECT 'statuses', count(*) FROM internal_ticket_statuses WHERE account_id = '<uuid>'
--       UNION ALL SELECT 'stages', count(*) FROM internal_ticket_stages WHERE account_id = '<uuid>'
--       UNION ALL SELECT 'teams', count(*) FROM internal_teams WHERE account_id = '<uuid>';
--     Esperado: types=7, statuses=5, stages=3, teams=3 (companies=0,
--     sem seed por design).
--
-- ---- Bloco B — cenários com dados/sessão (destrutivo ou dependente de
--      auth.uid() — só em staging, criar/reverter dados de teste) ----
--
-- 10. Exatamente 1 default status/stage por account: para a mesma
--     account de teste,
--       SELECT count(*) FROM internal_ticket_statuses WHERE account_id = '<uuid>' AND is_default;
--       SELECT count(*) FROM internal_ticket_stages   WHERE account_id = '<uuid>' AND is_default;
--     Esperado: 1 e 1. Tentar INSERT de um segundo status/stage com
--     is_default=true na mesma account -> rejeitado (unique_violation
--     no índice parcial). Tentar UPDATE do status/stage atualmente
--     default para is_active=false sem antes desmarcar is_default ->
--     rejeitado (CHECK NOT is_default OR is_active).
--
-- 11. Catálogos isolados por account: criar uma 2ª account de teste,
--     confirmar que os 7 types/5 statuses/3 stages/3 teams seedados
--     nela são linhas DIFERENTES (ids distintos) das da 1ª account,
--     mesmo com nomes iguais (UNIQUE é por (account_id, name), não
--     global).
--
-- 12. Cross-tenant type rejeitado: tentar INSERT/UPDATE em
--     internal_tickets com type_id de uma internal_ticket_types de
--     OUTRA account -> rejeitado ("type_id must reference a type in
--     the same account").
-- 13. Idem para status_id -> rejeitado ("status_id must reference a
--     status in the same account").
-- 14. Idem para stage_id -> rejeitado ("stage_id must reference a
--     stage in the same account").
-- 15. Idem para team_id -> rejeitado ("team_id must reference a team
--     in the same account").
-- 16. Idem para internal_company_id -> rejeitado ("internal_company_id
--     must reference a company in the same account").
--
-- 17. assigned_user_id de outra account -> rejeitado
--     ("assigned_user_id must reference a profile in the same account").
-- 18. assigned_user_id de um profile com is_active=false -> rejeitado
--     ("assigned_user_id must reference an active profile").
--
-- 19. internal_team_members com (team_id, account_id) apontando para
--     uma internal_teams de OUTRA account -> rejeitado pela FK
--     composta (violação de chave estrangeira, não uma mensagem
--     custom) — confirmar que o erro é de FK, não silencioso.
-- 20. internal_team_members com is_active=true para um user_id cujo
--     profile tem is_active=false -> rejeitado ("must reference an
--     active profile to become an active member"). Testar também via
--     UPDATE (reativar uma membership existente de um profile inativo)
--     -> mesma rejeição.
--
-- 21. Desativação de profile (UPDATE profiles SET is_active=false)
--     limpa assignee: criar um internal_tickets com
--     assigned_user_id = X e uma internal_team_members ativa de X;
--     desativar o profile de X; confirmar
--       SELECT assigned_user_id FROM internal_tickets WHERE id = '<ticket>';  -- NULL
--       SELECT is_active FROM internal_team_members WHERE user_id = 'X';      -- false
--     e confirmar que status_id/stage_id/team_id do ticket NÃO mudaram.
--
-- 22. Código interno sequencial por account: chamar
--       SELECT allocate_internal_ticket_number('<uuid-account-A>') AS n1,
--              allocate_internal_ticket_number('<uuid-account-A>') AS n2;
--     (como postgres/service_role — a função não tem GRANT para
--     authenticated nesta fase) -> n1=1, n2=2 na primeira execução
--     limpa para essa account (ou N, N+1 se já houver contador).
-- 23. Duas accounts têm contadores independentes: repetir o mesmo
--     para '<uuid-account-B>' -> começa em 1 (ou o próprio valor
--     independente), não continua a sequência da account A.
-- 24. Concorrência não gera internal_code duplicado: disparar N
--     chamadas concorrentes de allocate_internal_ticket_number para a
--     MESMA account (ex.: pgbench ou N conexões psql simultâneas) e
--     confirmar N valores distintos retornados, sem gaps inesperados
--     além dos já esperados por retries; e que
--     UNIQUE(account_id, internal_code) em internal_tickets nunca é
--     violado quando esses números forem de fato usados numa fase
--     futura (052-INT-C).
--
-- 25. Viewer não vê chamados globais: autenticar como um profile
--     account_role='viewer' que NÃO é created_by/assigned_user_id/
--     membro de nenhum team_id dos tickets existentes -> SELECT *
--     FROM internal_tickets retorna 0 linhas para esses tickets.
-- 26. Agent não vê chamado sem envolvimento: mesmo teste do item 25,
--     com um profile account_role='agent' sem nenhum vínculo com o
--     ticket -> 0 linhas para esse ticket.
-- 27. Agent vê chamado em que está envolvido: repetir com um ticket
--     onde o agent é created_by, OU assigned_user_id, OU membro ATIVO
--     do team_id do ticket (testar os três casos separadamente) ->
--     ticket aparece no SELECT nos três casos.
-- 28. Owner/admin vê tudo da própria account: autenticar como
--     account_role IN ('owner','admin') -> SELECT * FROM
--     internal_tickets retorna TODOS os tickets da account, inclusive
--     os sem nenhum envolvimento direto do chamador.
-- 29. Nenhuma leitura cross-tenant: para qualquer papel (owner/admin/
--     agent/viewer) de uma account A, SELECT * FROM internal_tickets /
--     internal_ticket_comments / internal_ticket_events /
--     internal_ticket_types / internal_ticket_statuses /
--     internal_ticket_stages / internal_companies / internal_teams /
--     internal_team_members nunca retorna nenhuma linha cujo
--     account_id seja de outra account B, independentemente do papel.
-- 30. Nenhum DELETE físico de configuração/membership pelo cliente:
--     autenticado como owner/admin (o papel mais privilegiado com
--     policy em qualquer uma dessas 6 tabelas), tentar DELETE FROM
--     internal_ticket_types / internal_ticket_statuses /
--     internal_ticket_stages / internal_companies / internal_teams /
--     internal_team_members -> rejeitado pela RLS nas 6 (sem policy de
--     DELETE em NENHUMA delas -> default-deny). CORRIGIDO nesta
--     revisão: internal_team_members deixou de ser exceção — até a
--     revisão anterior tinha uma policy internal_team_members_delete
--     permitindo DELETE por admin+ (mesmo recorte de queue_members,
--     039); a decisão de produto para este módulo é diferente
--     (histórico de participação sempre preservado, entrada/saída só
--     via is_active), então essa policy foi removida (seção 3.2). A
--     partir de agora, nenhuma tabela internal_* de configuração/
--     membership tem DELETE físico pelo cliente, sem exceção nenhuma.
--
-- ---- Bloco C — hardening da revisão anterior (imutabilidade de
--      campos de sistema, seção 2.10) ----
--
-- 31. UPDATE account_id rejeitado, nas 9 tabelas (testar cada uma
--     isoladamente, autenticado como admin/owner — o papel mais
--     privilegiado com qualquer policy de UPDATE nessas tabelas):
--       UPDATE internal_ticket_types    SET account_id = '<outra>' WHERE id = '<id>';
--       UPDATE internal_ticket_statuses SET account_id = '<outra>' WHERE id = '<id>';
--       UPDATE internal_ticket_stages   SET account_id = '<outra>' WHERE id = '<id>';
--       UPDATE internal_companies       SET account_id = '<outra>' WHERE id = '<id>';
--       UPDATE internal_teams           SET account_id = '<outra>' WHERE id = '<id>';
--       UPDATE internal_team_members    SET account_id = '<outra>' WHERE id = '<id>';
--       UPDATE internal_tickets         SET account_id = '<outra>' WHERE id = '<id>';
--       UPDATE internal_ticket_comments SET account_id = '<outra>' WHERE id = '<id>';
--       UPDATE internal_ticket_events   SET account_id = '<outra>' WHERE id = '<id>';
--     Esperado nas 9: rejeitado ("<tabela>.account_id cannot be
--     changed after creation"). Repetir como postgres/service_role
--     (bypassando RLS) para confirmar que o bloqueio é do trigger, não
--     só da policy — deve rejeitar igual.
-- 32. UPDATE account_id para o MESMO valor já existente (SET
--     account_id = account_id, sem mudança real) -> permitido nas 9,
--     sem disparar a exceção (o guard só reage a IS DISTINCT FROM).
--
-- 33. UPDATE id rejeitado, nas 9 tabelas (mesmo padrão do item 31,
--     trocando account_id por id) -> rejeitado ("<tabela>.id cannot be
--     changed after creation") nas 9, inclusive como postgres/
--     service_role.
-- 34. UPDATE created_at rejeitado, nas 9 tabelas -> rejeitado
--     ("<tabela>.created_at cannot be changed after creation") nas 9,
--     inclusive como postgres/service_role.
--
-- 35. UPDATE created_by rejeitado em internal_tickets -> rejeitado
--     ("internal_tickets.created_by cannot be changed after
--     creation"), inclusive como postgres/service_role. Confirmar em
--     paralelo que UPDATE assigned_user_id no MESMO ticket continua
--     permitido normalmente (não confundir os dois campos).
-- 36. UPDATE internal_code rejeitado em internal_tickets -> rejeitado
--     ("internal_tickets.internal_code cannot be changed after
--     creation").
--
-- 37. UPDATE author_id rejeitado em internal_ticket_comments ->
--     rejeitado ("internal_ticket_comments.author_id cannot be
--     changed after creation"), mesmo tentado pelo próprio autor
--     (author_id = auth.uid() não é suficiente — author_id é sempre
--     imutável, ponto).
-- 38. Comentário não pode ser movido para outro ticket: UPDATE
--     internal_ticket_comments SET ticket_id = '<outro-ticket>' WHERE
--     id = '<id>' -> rejeitado ("internal_ticket_comments.ticket_id
--     cannot be changed after creation"), tanto para um ticket da
--     MESMA account quanto de outra account (o guard de imutabilidade
--     dispara antes mesmo do trigger de tenancy avaliar a diferença).
--
-- 39. allocate_internal_ticket_number sem EXECUTE direto para nenhuma
--     role client-facing/service (postgres, o owner, é a única exceção
--     esperada — ver item 7 para o motivo):
--       SELECT p.proname, a.grantee, a.privilege_type
--       FROM information_schema.routine_privileges a
--       JOIN pg_proc p ON p.proname = a.routine_name
--       WHERE a.routine_schema = 'public'
--         AND p.proname = 'allocate_internal_ticket_number'
--         AND a.grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role');
--     Esperado: ZERO linhas (nem PUBLIC, nem anon, nem authenticated,
--     nem service_role têm GRANT). Confirmar também que uma sessão
--     authenticated comum recebe "permission denied for function
--     allocate_internal_ticket_number" ao tentar
--     SELECT allocate_internal_ticket_number('<account>') via
--     PostgREST RPC.
--
-- 40. USING/WITH CHECK de internal_tickets_update (reconfirmação após
--     o hardening): um agent cujo único vínculo com um ticket é
--     assigned_user_id = auth.uid() tenta, num único UPDATE, trocar
--     team_id para um time do qual NÃO é membro ativo E
--     simultaneamente limpar assigned_user_id (SET team_id =
--     '<outro-time>', assigned_user_id = NULL) -> rejeitado pelo WITH
--     CHECK inteiro (a linha nova não bate mais em nenhuma das
--     condições de envolvimento: não é created_by, assigned_user_id
--     virou NULL, e não é membro do team_id novo) — nem a troca de
--     time nem a limpeza do assignee são aplicadas, a transação inteira
--     falha. Repetir trocando team_id para um time do qual o mesmo
--     agent É membro ativo -> permitido (transferência legítima entre
--     times aos quais pertence).
--
-- ---- Bloco D — hardening desta revisão (tenancy de usuários de
--      auditoria + seed rename-safe) ----
--
-- 41. internal_tickets.created_by de OUTRA account -> rejeitado
--     ("internal_tickets.created_by must reference a profile in the
--     same account"). Só se aplica em INSERT (created_by é imutável —
--     Bloco C, item 35 — então não há UPDATE a testar aqui).
-- 42. internal_tickets.created_by com profile.is_active=false no
--     momento do INSERT -> rejeitado ("internal_tickets.created_by
--     must reference an active profile").
--
-- 43. internal_ticket_comments.author_id de OUTRA account -> rejeitado
--     ("internal_ticket_comments.author_id must reference a profile in
--     the same account"). Só em INSERT (author_id imutável — Bloco C,
--     item 37).
-- 44. internal_ticket_comments.author_id com profile.is_active=false
--     no momento do INSERT -> rejeitado ("internal_ticket_comments.
--     author_id must reference an active profile").
--
-- 45. internal_ticket_comments.deleted_by de OUTRA account, setado via
--     UPDATE (soft-delete) -> rejeitado ("internal_ticket_comments.
--     deleted_by must reference a profile in the same account").
-- 46. internal_ticket_comments.deleted_by com profile.is_active=false
--     no momento do soft-delete -> rejeitado ("internal_ticket_
--     comments.deleted_by must reference an active profile").
-- 47. UPDATE em internal_ticket_comments que NÃO toca deleted_by (ex.:
--     só edita body, ou marca deleted_at/deleted_by pela primeira vez
--     mas deleted_by já tinha sido setado antes e continua o mesmo
--     valor) -> validate_tenancy nem chega a checar deleted_by de novo
--     (v_check_deleted_by fica false) — nenhuma query extra, nenhuma
--     rejeição indevida.
--
-- 48. internal_ticket_events.actor_user_id de OUTRA account -> mesmo
--     sem RPC/trigger nenhum inserindo nesta tabela ainda, simular via
--     postgres/service_role um INSERT direto com actor_user_id de
--     outra account -> rejeitado ("internal_ticket_events.actor_user_id
--     must reference a profile in the same account").
-- 49. internal_ticket_events.actor_user_id com profile.is_active=false
--     -> PERMITIDO (decisão deliberada — campo histórico, não exige
--     ativo; ver comentário em internal_ticket_events_validate_tenancy,
--     2.5). Confirmar que o INSERT passa normalmente nesse caso,
--     diferente dos itens 42/44/46 acima.
--
-- 50. Seed idempotente após rename do default (bug corrigido nesta
--     revisão): numa account de teste já seedada, UPDATE
--     internal_ticket_statuses SET name = 'Aberto' WHERE account_id =
--     '<uuid>' AND is_default; em seguida chamar novamente (como
--     postgres) SELECT public.seed_internal_ticket_defaults_for_account
--     ('<uuid>') -> sucesso, SEM exceção de unique_violation. Confirmar
--     depois:
--       SELECT count(*) FROM internal_ticket_statuses WHERE account_id = '<uuid>' AND is_default;
--     Esperado: 1 (continua sendo a linha 'Aberto', renomeada pelo
--     usuário — nenhuma segunda linha 'Em andamento' é criada).
--     Repetir o mesmo teste para internal_ticket_stages (renomear
--     'Solicitação' e reseedar).
-- 51. Mesmo teste do item 50, mas SEM renomear nada (reseed puro de
--     uma account já seedada) -> continua idempotente como antes:
--     nenhuma linha nova em nenhum dos 4 catálogos com seed.
--
-- ---- Bloco E — hardening desta revisão (profile ausente rejeitado +
--      internal_team_members sem DELETE físico + identidade de
--      membership imutável) ----
--
-- Setup comum aos itens 52-56: um auth.users que EXISTE (signup válido,
-- linha real em auth.users) mas cujo profiles correspondente foi
-- excluído manualmente (ex.: DELETE FROM profiles WHERE user_id = X,
-- via service_role — o único jeito de produzir esse estado hoje, já
-- que profiles normalmente nasce junto do auth.users via
-- handle_new_user) ou nunca chegou a ser criado (reproduzindo o orphan
-- histórico documentado em 017: "pre-017 signup trigger could leave an
-- auth.users row with no matching profiles row"). Sem NENHUMA linha em
-- profiles para esse user_id — a FK para auth.users(id) continua
-- satisfeita (o usuário existe), só não há profile.
--
-- 52. internal_tickets.assigned_user_id = esse user_id -> rejeitado
--     ("internal_tickets.assigned_user_id must reference a profile"),
--     não "an active profile" nem "in the same account" — mensagem
--     específica de ausência.
-- 53. internal_tickets.created_by = esse user_id, no INSERT ->
--     rejeitado ("internal_tickets.created_by must reference a
--     profile").
-- 54. internal_ticket_comments.author_id = esse user_id, no INSERT ->
--     rejeitado ("internal_ticket_comments.author_id must reference a
--     profile").
-- 55. internal_ticket_comments.deleted_by = esse user_id, via UPDATE
--     de soft-delete -> rejeitado ("internal_ticket_comments.
--     deleted_by must reference a profile").
-- 56. internal_ticket_events.actor_user_id = esse user_id (INSERT
--     direto como postgres/service_role, já que não há RPC/trigger
--     inserindo aqui ainda) -> rejeitado ("internal_ticket_events.
--     actor_user_id must reference a profile") — mesmo sem exigir
--     is_active (item 49), a EXISTÊNCIA do profile continua obrigatória.
--
-- 57. internal_team_members.user_id não é afetado pelos itens acima —
--     confirmar que continua coberto pela FK composta
--     (user_id, account_id) REFERENCES profiles(user_id, account_id),
--     que já rejeita um user_id sem profile na account (violação de
--     FK, não uma RAISE EXCEPTION custom) — nada muda aqui nesta
--     revisão.
--
-- 58. internal_team_members sem DELETE físico (correção desta
--     revisão): autenticado como owner/admin, tentar DELETE FROM
--     internal_team_members WHERE id = '<id>' -> rejeitado pela RLS
--     (default-deny, sem policy de DELETE). Confirmar que a MESMA
--     linha pode ser desativada normalmente via UPDATE
--     internal_team_members SET is_active = false WHERE id = '<id>'
--     -> sucesso, linha continua existindo com is_active=false.
--
-- 59. UPDATE team_id de uma membership existente -> rejeitado
--     ("internal_team_members.team_id cannot be changed after
--     creation"), inclusive como postgres/service_role (mesmo padrão
--     incondicional do restante do guard de imutabilidade, 2.10).
-- 60. UPDATE user_id de uma membership existente -> rejeitado
--     ("internal_team_members.user_id cannot be changed after
--     creation"), inclusive como postgres/service_role.
-- 61. UPDATE is_active (true -> false ou false -> true) numa
--     membership existente, sem tocar team_id/user_id -> permitido
--     normalmente (is_active continua o único mecanismo de entrada/
--     saída; nenhuma das colunas protegidas por prevent_system_
--     column_change é afetada por essa UPDATE).
-- 62. Fluxo operacional correto para mover uma pessoa de equipe:
--     (a) UPDATE internal_team_members SET is_active = false WHERE
--     team_id = '<time-antigo>' AND user_id = '<pessoa>' -> sucesso
--     (item 61); (b) INSERT INTO internal_team_members (account_id,
--     team_id, user_id) VALUES ('<account>', '<time-novo>',
--     '<pessoa>') -> sucesso, nova linha independente, is_active=true
--     por default, sujeita à validação normal de
--     internal_team_members_validate_active (2.6). Confirmar ao final
--     que existem DUAS linhas para a mesma pessoa (uma inativa no time
--     antigo, uma ativa no time novo) — nunca uma única linha
--     repontada.
-- ============================================================
