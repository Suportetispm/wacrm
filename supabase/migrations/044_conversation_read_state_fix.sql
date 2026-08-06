-- ============================================================
-- 044_conversation_read_state_fix
--
-- FASE 5B — substitui o update direto do cliente
-- `supabase.from('conversations').update({ unread_count: 0 })` (um
-- write cru via PostgREST que falha silenciosamente para chamadas com
-- role `viewer`, porque a RLS `conversations_update`
-- (017_account_sharing.sql:416) exige role >= 'agent' e um UPDATE
-- filtrado a 0 linhas pela RLS é indistinguível de sucesso — ver a
-- auditoria da FASE 5A) por uma RPC estreita que permite
-- explicitamente qualquer role real da conta marcar uma conversa como
-- lida, sem escrever mais nada.
--
-- NÃO altera conversations.status, tickets, o modelo de cinco status
-- ou qualquer sincronização ticket/conversa — tudo isso está
-- explicitamente fora do escopo desta fase (ver o relatório de
-- auditoria da FASE 5A).
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- mark_conversation_read(p_conversation_id)
-- ------------------------------------------------------------
-- SECURITY DEFINER, não INVOKER — deliberadamente, e só depois de
-- considerar a alternativa INVOKER:
--
-- Uma função INVOKER roda sob a RLS do próprio chamador, então
-- herdaria exatamente o mesmo problema que esta migration existe para
-- corrigir: `conversations_update` exige role >= 'agent', então um
-- UPDATE feito por um chamador `viewer` ainda seria silenciosamente
-- filtrado para 0 linhas. Marcar uma conversa como lida é
-- deliberadamente NÃO restringido do mesmo jeito que escritas
-- operacionais reais (status, atribuição) são — leitura não é uma
-- mudança operacional, então `viewer` também precisa ser permitido
-- (decisão de produto da auditoria da FASE 5A). Ampliar a própria
-- `conversations_update` foi descartado: essa policy vale para a
-- tabela inteira, sem restrição por coluna, então afrouxá-la para
-- admitir `viewer` também deixaria viewers escreverem
-- `status`/`assigned_agent_id` pelo caminho cru do PostgREST — uma
-- escalada de permissão real, não só uma correção de estado de
-- leitura.
--
-- SECURITY DEFINER roda como o dono da função (`postgres`), ignorando
-- a RLS por completo — o que significa que esta função precisa fazer
-- sua PRÓPRIA autorização em vez de depender da policy da tabela. Ela
-- faz isso com `is_account_member(account_id)`
-- (017_account_sharing.sql:136), a mesma primitiva que as policies
-- `conversations_select`/`conversations_update` já usam, com
-- `min_role := 'viewer'` por padrão — ou seja, "qualquer membro real
-- da conta, em qualquer role, incluindo viewer."
--
-- A ÚNICA coluna que esta função escreve é `unread_count`, e sempre
-- para `0` — nunca `status`, `assigned_agent_id` ou qualquer outra
-- coisa. É exatamente tão restrita quanto o nome sugere.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_conversation_read(p_conversation_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conversation_account_id UUID;
  v_updated_rows            INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_conversation_id IS NULL THEN
    RAISE EXCEPTION 'Conversation ID is required';
  END IF;

  -- FOR UPDATE: trava a linha pelo resto desta transação, para que um
  -- DELETE concorrente (ou um UPDATE que altere a linha) não consiga
  -- se intrometer entre esta checagem de existência/tenancy e o
  -- UPDATE abaixo — sem a trava, um delete correndo bem aqui poderia
  -- fazer o UPDATE abaixo casar 0 linhas para uma conversa que já não
  -- existe mais, o que seria indistinguível do caso legítimo "já
  -- estava em 0" e retornaria incorretamente 'already_read' em vez de
  -- falhar.
  SELECT account_id INTO v_conversation_account_id
  FROM public.conversations
  WHERE id = p_conversation_id
  FOR UPDATE;

  -- Mesma exceção para "conversa não existe" e "existe, mas o
  -- chamador não é membro da conta dela" — deliberadamente. Esta
  -- função ignora a RLS (SECURITY DEFINER), então nunca pode deixar
  -- um chamador distinguir esses dois casos; isso permitiria que uma
  -- conta sondasse ids de conversa de outra conta pela mensagem de
  -- erro.
  IF v_conversation_account_id IS NULL
     OR NOT public.is_account_member(v_conversation_account_id) THEN
    RAISE EXCEPTION 'Conversation not found';
  END IF;

  -- `AND unread_count <> 0` torna um resultado de 0 linhas
  -- inequívoco: neste ponto existência e associação à conta já foram
  -- confirmadas (e a linha está travada via FOR UPDATE acima, então
  -- não pode ter sido excluída embaixo de nós desde então), então 0
  -- linhas aqui só pode significar "já estava em 0" (retornado abaixo
  -- como um resultado explícito e distinto) — nunca uma falha de
  -- autorização ou existência engolida silenciosamente, ao contrário
  -- do UPDATE cru do cliente que esta função substitui.
  UPDATE public.conversations
  SET unread_count = 0
  WHERE id = p_conversation_id
    AND unread_count <> 0;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

  IF v_updated_rows = 0 THEN
    RETURN 'already_read';
  END IF;

  RETURN 'marked_read';
END;
$$;

-- ---- owner ----------------------------------------------------
ALTER FUNCTION public.mark_conversation_read(UUID) OWNER TO postgres;

-- ---- permissions ----------------------------------------------
-- `authenticated` apenas — esta RPC é feita para ser chamada
-- diretamente pelo cliente de sessão do navegador, exatamente como o
-- `.update()` cru que ela substitui fazia (message-thread.tsx), sem
-- passar por uma rota de servidor. Deliberadamente NÃO concedida a
-- `service_role`: a função exige `auth.uid()` não nulo (e lança
-- exceção caso contrário), e um cliente service_role não tem JWT de
-- usuário final para satisfazer isso — conceder EXECUTE a uma role
-- que nunca conseguiria passar pelo próprio contrato da função seria
-- uma concessão morta e enganosa. Um futuro caminho service_role/admin
-- (ex.: uma ação em massa "marcar tudo como lido") precisaria da sua
-- própria função, não desta. Nunca `anon` ou `PUBLIC` — um chamador
-- não autenticado também não tem `auth.uid()` e é rejeitado pela
-- primeira checagem de qualquer forma, mas a concessão em si é negada
-- mesmo assim, como defesa em profundidade.
REVOKE ALL ON FUNCTION public.mark_conversation_read(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_conversation_read(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.mark_conversation_read(UUID) FROM service_role;
GRANT EXECUTE ON FUNCTION public.mark_conversation_read(UUID) TO authenticated;
