-- ============================================================
-- 053_internal_ticket_default_rpc
--
-- Correção BLOQUEANTE encontrada na revisão de segurança da fase
-- 052-INT-B (settings/admin UI de internal_ticket_statuses e
-- internal_ticket_stages — código de aplicação em
-- src/app/api/internal-tickets/{statuses,stages}/**, não faz parte
-- da migration 052, que já foi aplicada e NÃO é tocada aqui).
--
-- BUG: as rotas de API trocavam o registro default de status/etapa
-- com DUAS chamadas independentes ao Postgres — UPDATE ...
-- is_default=false no antigo default, seguido de um INSERT/UPDATE
-- separado com is_default=true no novo. Duas transações distintas:
-- uma falha entre as duas (ex.: 23505 de nome duplicado no segundo
-- passo) deixava a account sem NENHUM default, sem qualquer
-- recuperação automática.
--
-- CORREÇÃO: duas funções SECURITY DEFINER — uma por tabela — cada
-- uma fazendo "localizar o alvo (com lock) + desmarcar os demais +
-- marcar o alvo" inteiramente dentro do próprio corpo da função, ou
-- seja, dentro de uma única transação implícita do Postgres.
-- Qualquer RAISE EXCEPTION em qualquer ponto desfaz TODOS os efeitos
-- já aplicados por aquela chamada — nunca existe um estado "só
-- desmarquei, ainda não marquei" que sobrevive a uma falha. Mesmo
-- padrão de atomicidade já documentado em open_ticket_for_conversation
-- (migration 040).
--
-- Chamadas exclusivamente por rotas server-side (052-INT-B) já
-- autenticadas via requireRole('admin'), sempre com p_account_id =
-- ctx.accountId (nunca vindo do browser) — GRANT EXECUTE só para
-- service_role, mesmo padrão de open_ticket_for_conversation/
-- allocate_internal_ticket_number.
--
-- "Não encontrado" e "existe mas é de outra account" retornam a
-- MESMA mensagem/código (P0002) — mesma convenção já usada pelas
-- rotas REST deste projeto (ex.: GET/PATCH /api/queues/[id] devolvem
-- um único "not found" tanto para id inexistente quanto para id de
-- outra conta) — nunca dar ao chamador um oráculo que confirme "este
-- UUID existe, só não é seu".
--
-- Idempotente — mesmo padrão do resto do projeto: CREATE OR REPLACE
-- FUNCTION substitui a função inteira sem afetar owner/grants
-- (reaplicados explicitamente logo abaixo de cada uma de qualquer
-- forma).
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_internal_ticket_status_default(
  p_account_id UUID,
  p_status_id UUID
) RETURNS internal_ticket_statuses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row internal_ticket_statuses;
BEGIN
  -- Lock o alvo primeiro — serializa chamadas concorrentes mirando a
  -- MESMA linha.
  --
  -- Concorrência (revisão pós-053): duas promoções concorrentes
  -- mirando LINHAS DIFERENTES podem serializar de mais de uma forma —
  -- não depender de qual delas ocorre. Possibilidades observáveis:
  -- a última chamada a terminar pode simplesmente prevalecer, sem
  -- erro nenhum para nenhuma das duas; OU uma delas pode falhar com
  -- 23505 ao tentar marcar seu próprio alvo, caso não volte a
  -- enxergar uma linha is_default=true para desmarcar depois de
  -- esperar o lock. Qualquer chamada que falhar é revertida
  -- integralmente (nenhum efeito parcial persiste).
  --
  -- A única garantia obrigatória, independente de qual desses
  -- comportamentos ocorrer: depois de qualquer sequência de chamadas
  -- concorrentes, nunca fica zero default nem dois defaults. O índice
  -- único parcial da migration 052 é a defesa final dessa unicidade.
  SELECT * INTO v_row
  FROM internal_ticket_statuses
  WHERE id = p_status_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'internal_ticket_statuses not found' USING ERRCODE = 'P0002';
  END IF;
  -- Mesma mensagem/código do "não encontrado" acima — de propósito,
  -- ver cabeçalho do arquivo.
  IF v_row.account_id <> p_account_id THEN
    RAISE EXCEPTION 'internal_ticket_statuses not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_row.is_active THEN
    RAISE EXCEPTION 'a default status must be active' USING ERRCODE = '23514';
  END IF;

  -- Já é o default: no-op idempotente, não toca em mais nenhuma
  -- linha (evita um UPDATE de "desmarcar os demais" desnecessário
  -- quando não há mudança real nenhuma a fazer).
  IF v_row.is_default THEN
    RETURN v_row;
  END IF;

  UPDATE internal_ticket_statuses
  SET is_default = false
  WHERE account_id = p_account_id
    AND is_default = true;

  UPDATE internal_ticket_statuses
  SET is_default = true
  WHERE id = p_status_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

ALTER FUNCTION public.set_internal_ticket_status_default(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_internal_ticket_status_default(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_internal_ticket_status_default(UUID, UUID) TO service_role;

-- Idêntica a set_internal_ticket_status_default acima, para
-- internal_ticket_stages — ver comentários lá para o raciocínio
-- completo; não repetido aqui.
CREATE OR REPLACE FUNCTION public.set_internal_ticket_stage_default(
  p_account_id UUID,
  p_stage_id UUID
) RETURNS internal_ticket_stages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row internal_ticket_stages;
BEGIN
  SELECT * INTO v_row
  FROM internal_ticket_stages
  WHERE id = p_stage_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'internal_ticket_stages not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.account_id <> p_account_id THEN
    RAISE EXCEPTION 'internal_ticket_stages not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_row.is_active THEN
    RAISE EXCEPTION 'a default stage must be active' USING ERRCODE = '23514';
  END IF;

  IF v_row.is_default THEN
    RETURN v_row;
  END IF;

  UPDATE internal_ticket_stages
  SET is_default = false
  WHERE account_id = p_account_id
    AND is_default = true;

  UPDATE internal_ticket_stages
  SET is_default = true
  WHERE id = p_stage_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

ALTER FUNCTION public.set_internal_ticket_stage_default(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_internal_ticket_stage_default(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_internal_ticket_stage_default(UUID, UUID) TO service_role;

-- ============================================================
-- VALIDAÇÃO MANUAL (não existe harness de teste SQL automatizado
-- neste repositório — mesmo aviso já registrado em 034/041/049-052).
-- Rodar contra staging, nunca produção, antes/depois de aplicar.
-- Todos os itens abaixo valem igualmente para
-- set_internal_ticket_stage_default / internal_ticket_stages,
-- trocando status<->stage.
--
--  1. Troca simples: SELECT set_internal_ticket_status_default(
--     '<account>', '<status-B-ativo>') com A sendo o default atual ->
--     sucesso; SELECT count(*) FROM internal_ticket_statuses WHERE
--     account_id='<account>' AND is_default -> 1 (só B).
--  2. Promover status inativo -> rejeitado ("a default status must be
--     active", ERRCODE 23514); nenhuma linha é alterada (nem o unset
--     do antigo default chega a rodar, porque a checagem de
--     is_active acontece ANTES de qualquer UPDATE no corpo da
--     função).
--  3. ID inexistente -> rejeitado ("internal_ticket_statuses not
--     found", ERRCODE P0002).
--  4. ID de OUTRA account -> rejeitado com a MESMA mensagem/código do
--     item 3 (P0002) — confirmar que não é distinguível de "não
--     existe" por quem chama.
--  5. Rollback transacional (observação conceitual, sem passo
--     destrutivo a executar): como as duas UPDATEs do corpo da função
--     rodam na mesma transação implícita do PL/pgSQL, qualquer RAISE
--     EXCEPTION em qualquer ponto — inclusive um hipotético erro no
--     segundo UPDATE — desfaz TODOS os efeitos já aplicados por
--     aquela chamada, incluindo o primeiro UPDATE (o "desmarcar os
--     demais"). Não há um estado intermediário "só desmarquei, ainda
--     não marquei" que sobrevive a uma falha — SELECT count(*) FROM
--     internal_ticket_statuses WHERE account_id='<account>' AND
--     is_default continua 1 (o default ANTIGO) depois de qualquer
--     falha simulada.
--  6. Confirmar que o default resultante sempre tem is_active=true
--     (implícito pelo item 2 + pelo CHECK da migration 052).
--  7. Nunca dois defaults: repetir o item 1 em sequência para vários
--     status diferentes -> a cada chamada, count(is_default)=1,
--     nunca 0, nunca 2.
--  8. Chamar com o MESMO status que já é o default -> sucesso,
--     no-op, nenhuma outra linha é tocada (confirmar via updated_at
--     das OUTRAS linhas — não muda).
--  9. GRANT — confirmar que nem PUBLIC, nem anon, nem authenticated
--     têm EXECUTE:
--       SELECT p.proname, a.grantee, a.privilege_type
--       FROM information_schema.routine_privileges a
--       JOIN pg_proc p ON p.proname = a.routine_name
--       WHERE a.routine_schema = 'public'
--         AND p.proname IN ('set_internal_ticket_status_default', 'set_internal_ticket_stage_default')
--         AND a.grantee IN ('PUBLIC', 'anon', 'authenticated');
--     Esperado: zero linhas. service_role deve aparecer com EXECUTE.
-- 10. Concorrência — duas sessões psql simultâneas, cada uma
--     promovendo um status DIFERENTE (ex.: sessão 1 promove B, sessão
--     2 promove C, com A sendo o default original), disparadas o mais
--     próximo possível uma da outra. Não depender de qual serialização
--     ocorre: a segunda sessão pode simplesmente prevalecer sem erro
--     nenhum, OU pode falhar com 23505 (ver comentário no corpo da
--     função acima) — qualquer chamada que falhar é revertida
--     integralmente. O que precisa ser verdade, sempre, é só isto:
--       SELECT count(*) FROM internal_ticket_statuses WHERE
--       account_id='<account>' AND is_default;
--     -> exatamente 1, nunca 0, nunca 2 — qualquer que seja a ordem
--     real de conclusão das duas sessões ou qual delas (se alguma)
--     falha com 23505.
-- ============================================================
