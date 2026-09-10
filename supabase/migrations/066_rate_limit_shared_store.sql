-- ============================================================
-- 066_rate_limit_shared_store
--
-- NÃO APLICADA — arquivo criado para revisão. Não rode contra
-- staging/produção sem antes ler o checklist de validação no rodapé.
--
-- Substitui o rate limiter em memória de src/lib/rate-limit.ts (um
-- Map por processo Node) por um contador compartilhado no Postgres,
-- consultado via uma única função RPC atômica. Motivação (achado de
-- severidade Alta na auditoria): em qualquer deploy com mais de uma
-- instância/réplica — múltiplas regiões, múltiplos nós, serverless
-- fan-out — cada processo mantinha seu próprio contador, multiplicando
-- silenciosamente o limite efetivo pelo número de instâncias; um
-- restart de processo também zerava todos os contadores de graça.
--
-- Escopo desta migration: SOMENTE a tabela + a função RPC. Nenhuma
-- mudança em src/lib/rate-limit.ts é aplicada por este arquivo (isso é
-- código da aplicação, não SQL) — o módulo já foi atualizado para
-- chamar esta RPC como armazenamento primário, com fallback automático
-- para o limitador em memória (comportamento anterior) se esta RPC
-- falhar. Ver o cabeçalho de src/lib/rate-limit.ts para o raciocínio
-- completo de "fail-open vs fail-closed".
--
-- NÃO é uma tabela de dados de tenant: `key` é uma string opaca já
-- montada pelo chamador (ex.: `send:${userId}`, `apikey:${keyId}`,
-- `peek:${ip}`, `ai-draft-acct:${accountId}`) que já embute qualquer
-- isolamento necessário — por usuário, por conta, por API key, ou por
-- IP, conforme cada rota já fazia antes desta migration. Esta migration
-- NÃO decide isolamento nenhum; só troca ONDE o contador é guardado.
--
-- REVISÃO (auditoria adversarial pós-primeira versão) — 2 correções
-- aplicadas antes de qualquer aplicação em staging:
--   1. search_path/qualificação de schema: a 1ª versão usava
--      `SET search_path = public` e referenciava `rate_limit_buckets`
--      sem prefixo dentro da função. `pg_temp` é sempre pesquisado
--      ANTES de qualquer search_path explícito para nomes de relação
--      não qualificados — mesmo com `search_path = public`, isso deixa
--      uma janela teórica de search-path hijacking via uma tabela
--      temporária `pg_temp.rate_limit_buckets`. Corrigido para
--      `SET search_path = ''` (o mais defensivo possível — nenhum
--      schema de usuário fica implícito, só pg_catalog continua
--      sempre pesquisado para os tipos/funções nativas usadas aqui)
--      + toda referência à tabela qualificada explicitamente como
--      `public.rate_limit_buckets`, no INSERT e no DELETE. Com isso,
--      mesmo que alguém crie `pg_temp.rate_limit_buckets`, a função
--      nunca a alcança — ela sempre resolve para a tabela real.
--   2. Validação de entrada: a 1ª versão não validava `p_key`/
--      `p_limit`/`p_window_ms` — confiava inteiramente em quem chama
--      (hoje sempre `src/lib/rate-limit.ts`, com constantes
--      hardcoded). Adicionados `RAISE EXCEPTION` explícitos no início
--      da função, antes de qualquer INSERT/UPDATE, para: `p_key` nulo/
--      vazio/só espaço, `p_key` acima de 512 caracteres, `p_limit`
--      nulo/≤0/acima de um teto defensivo, `p_window_ms` nulo/≤0/acima
--      de um teto defensivo. Ver comentários inline na função para a
--      justificativa de cada teto escolhido. Isso não muda nenhum
--      `RATE_LIMITS` do lado TypeScript — todos os valores atuais
--      continuam bem dentro dos novos limites.
-- ============================================================

-- ============================================================
-- 1. TABELA
-- ============================================================

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key       TEXT PRIMARY KEY,
  count     INTEGER NOT NULL,
  reset_at  TIMESTAMPTZ NOT NULL
);

-- Único índice necessário para o UPSERT abaixo é o da PRIMARY KEY
-- (key) — já criado implicitamente. Sem índice em reset_at: a limpeza
-- oportunista (seção 2) roda com pouca frequência e sobre uma tabela
-- pequena (uma linha por chave ativa, não por request), então um scan
-- sequencial ocasional é mais barato que manter mais um índice.

ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;

-- ---- 1.1 privilégios de tabela — default-deny explícito -------------
-- Mesmo racional de internal_ticket_participants (065, seção 1.3b):
-- nenhuma policy de SELECT/INSERT/UPDATE/DELETE é criada para
-- authenticated/anon — RLS habilitada + zero policies já nega tudo por
-- padrão, mas o REVOKE explícito documenta a intenção por leitura
-- direta do arquivo, sem depender de conhecer os grants default do
-- Supabase. A aplicação NUNCA acessa esta tabela diretamente — todo
-- acesso passa pela função rate_limit_check() abaixo, chamada via
-- supabaseAdmin() (service_role). service_role não é tocado pelos
-- REVOKEs (mesmo padrão de 046/065 — já é um role de confiança em todo
-- o projeto).
REVOKE ALL ON TABLE rate_limit_buckets FROM PUBLIC;
REVOKE ALL ON TABLE rate_limit_buckets FROM anon;
REVOKE ALL ON TABLE rate_limit_buckets FROM authenticated;

-- ============================================================
-- 2. FUNÇÃO — rate_limit_check() (checagem + incremento atômicos)
-- ============================================================
--
-- Contador de janela fixa, uma linha por chave. Um único INSERT ...
-- ON CONFLICT DO UPDATE faz o read-modify-write inteiro dentro do lock
-- de linha que o próprio Postgres adquire no upsert — duas chamadas
-- concorrentes para a MESMA chave nunca correm um SELECT-depois-UPDATE
-- não atômico (a 2ª chamada simplesmente espera o lock da 1ª e então
-- opera sobre o valor já atualizado). Isso é o requisito explícito de
-- "operação atômica para evitar race condition" da auditoria.
--
-- Semântica idêntica à implementação em memória que substitui: a
-- request número N dentro de uma janela é permitida enquanto N <=
-- p_limit; a janela expira e reinicia (count volta a 1) quando
-- reset_at já passou. ÚNICA diferença deliberada: sob um flood
-- sustentado acima do limite, esta versão continua incrementando
-- `count` além de p_limit pelo resto da janela (a versão em memória
-- travava o contador em `limit`) — inofensivo, não muda a decisão de
-- permitir/negar (sempre count <= limit decide), e se autocorrige na
-- próxima janela; `remaining` no chamador (rate-limit.ts) já usa
-- GREATEST(0, limit - count) para nunca ficar negativo.
CREATE OR REPLACE FUNCTION public.rate_limit_check(
  p_key TEXT,
  p_limit INTEGER,
  p_window_ms BIGINT
) RETURNS TABLE(allowed BOOLEAN, count INTEGER, reset_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
-- search_path vazio, o mais defensivo possível para uma função
-- SECURITY DEFINER: nenhum schema de usuário (nem `public`) fica
-- implícito. pg_catalog continua sempre pesquisado independentemente
-- disso (é como o Postgres resolve os tipos/funções nativas usadas
-- abaixo: TIMESTAMPTZ, BOOLEAN, clock_timestamp, make_interval,
-- random) — search_path vazio só afasta schemas DE USUÁRIO da
-- resolução implícita. Toda referência a `rate_limit_buckets` abaixo
-- é qualificada como `public.rate_limit_buckets` justamente para não
-- depender de search_path nenhum: mesmo que um chamador consiga criar
-- uma tabela `pg_temp.rate_limit_buckets` (pg_temp é sempre pesquisado
-- primeiro para relações não qualificadas, antes de qualquer
-- search_path — isso não muda com search_path=''), esta função nunca
-- referencia o nome sem prefixo, então nunca alcança a temporária.
SET search_path = ''
AS $$
DECLARE
  v_now      TIMESTAMPTZ := clock_timestamp();
  v_count    INTEGER;
  v_reset_at TIMESTAMPTZ;
  -- Tetos defensivos — nenhum destes limita o uso real do projeto
  -- hoje (ver RATE_LIMITS em src/lib/rate-limit.ts), só rejeitam
  -- entrada claramente incorreta antes que ela vire uma linha
  -- silenciosamente sem sentido na tabela.
  --   MAX_KEY_LENGTH: pedido explicitamente em 512 — folgado acima de
  --     qualquer key real (todas seguem o padrão "prefixo:uuid" ou
  --     "prefixo:ip", bem abaixo de 100 caracteres).
  --   MAX_LIMIT: o maior limite hoje configurado é 120 (react/
  --     publicApi, ambos em RATE_LIMITS). 100 000 dá ~800x de folga
  --     para qualquer bucket futuro plausível, e ainda assim rejeita
  --     um valor claramente incorreto (ex.: um bug de troca de
  --     argumento passando milissegundos no lugar do limite).
  --   MAX_WINDOW_MS: toda janela hoje é 60 000ms (60s) — nenhum bucket
  --     usa outra coisa. 86 400 000ms (24h) é o maior valor que ainda
  --     faz sentido conceitual para uma janela de rate limit deste
  --     tipo (abuso/custo, não sessão de longa duração), e barra um
  --     valor absurdamente grande (ex.: um epoch-timestamp passado por
  --     engano no lugar da duração da janela).
  MAX_KEY_LENGTH CONSTANT INTEGER := 512;
  MAX_LIMIT      CONSTANT INTEGER := 100000;
  MAX_WINDOW_MS  CONSTANT BIGINT  := 86400000;
BEGIN
  -- ---- validação de entrada — falha alto e cedo, antes de qualquer
  -- INSERT/UPDATE, em vez de deixar um valor sem sentido virar uma
  -- linha silenciosa (key vazia colidindo entre chamadores diferentes,
  -- limit/window <= 0 desligando o rate limit de fato) ou estourar só
  -- na constraint de NOT NULL da tabela com um erro genérico.
  IF p_key IS NULL OR p_key !~ '\S' THEN
    RAISE EXCEPTION 'rate_limit_check: p_key must not be null, empty, or whitespace-only'
      USING ERRCODE = '22023'; -- invalid_parameter_value
  END IF;
  IF length(p_key) > MAX_KEY_LENGTH THEN
    RAISE EXCEPTION 'rate_limit_check: p_key must be at most % characters (got %)',
      MAX_KEY_LENGTH, length(p_key)
      USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit <= 0 THEN
    RAISE EXCEPTION 'rate_limit_check: p_limit must be a positive integer (got %)', p_limit
      USING ERRCODE = '22023';
  END IF;
  IF p_limit > MAX_LIMIT THEN
    RAISE EXCEPTION 'rate_limit_check: p_limit must not exceed % (got %)', MAX_LIMIT, p_limit
      USING ERRCODE = '22023';
  END IF;
  IF p_window_ms IS NULL OR p_window_ms <= 0 THEN
    RAISE EXCEPTION 'rate_limit_check: p_window_ms must be a positive integer (got %)', p_window_ms
      USING ERRCODE = '22023';
  END IF;
  IF p_window_ms > MAX_WINDOW_MS THEN
    RAISE EXCEPTION 'rate_limit_check: p_window_ms must not exceed % (got %)', MAX_WINDOW_MS, p_window_ms
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.rate_limit_buckets AS b (key, count, reset_at)
  VALUES (p_key, 1, v_now + make_interval(secs => p_window_ms / 1000.0))
  ON CONFLICT (key) DO UPDATE SET
    count = CASE
      WHEN b.reset_at <= v_now THEN 1
      ELSE b.count + 1
    END,
    reset_at = CASE
      WHEN b.reset_at <= v_now THEN v_now + make_interval(secs => p_window_ms / 1000.0)
      ELSE b.reset_at
    END
  RETURNING b.count, b.reset_at INTO v_count, v_reset_at;

  -- Limpeza oportunista de chaves abandonadas (API key revogada, IP
  -- que nunca mais volta) — barata, fora do caminho crítico (roda
  -- DEPOIS do RETURNING acima já ter capturado o resultado desta
  -- chamada) e nunca afeta o resultado retornado. ~1 em 200 chamadas
  -- paga esse custo, então a tabela não cresce sem limite sem precisar
  -- de um cron job separado.
  IF random() < 0.005 THEN
    DELETE FROM public.rate_limit_buckets WHERE reset_at < v_now - INTERVAL '1 day';
  END IF;

  RETURN QUERY SELECT (v_count <= p_limit), v_count, v_reset_at;
END;
$$;

ALTER FUNCTION public.rate_limit_check(TEXT, INTEGER, BIGINT) OWNER TO postgres;

-- EXECUTE revogado de authenticated/anon — só service_role chama esta
-- função (via supabaseAdmin() em src/lib/rate-limit.ts). Um
-- authenticated comprometido não pode nem tentar chamar a RPC para
-- manipular o contador de outra chave (ex.: zerar o próprio budget).
REVOKE ALL ON FUNCTION public.rate_limit_check(TEXT, INTEGER, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_check(TEXT, INTEGER, BIGINT) TO service_role;

-- ============================================================
-- IDEMPOTÊNCIA: CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE
-- FUNCTION tornam este arquivo seguro para reexecutar após uma
-- aplicação anterior bem-sucedida. REVOKE/GRANT são no-op quando já
-- aplicados. Mesma ressalva de sempre: CREATE TABLE IF NOT EXISTS não
-- reconcilia uma tabela pré-existente com um formato diferente do
-- definido aqui.
-- ============================================================

-- ============================================================
-- VALIDAÇÃO MANUAL (rodar em staging, nunca produção, antes/depois de
-- aplicar — mesmo aviso já registrado em 034/049-054/063/065):
--
--  1. rate_limit_buckets existe, RLS habilitada, zero policies.
--  2. SELECT grantee, privilege_type FROM information_schema.
--     role_table_grants WHERE table_name = 'rate_limit_buckets' AND
--     grantee IN ('anon','authenticated','PUBLIC') -> zero linhas.
--  3. SELECT * FROM rate_limit_check('smoke:1', 3, 60000) três vezes
--     seguidas -> allowed=true nas 3, count = 1,2,3. Uma 4ª chamada no
--     mesmo minuto -> allowed=false, count=4.
--  4. Duas conexões psql concorrentes chamando rate_limit_check com a
--     MESMA chave em paralelo (ex.: via `pgbench -f` com 2 clients, ou
--     duas abas manuais disparando na mesma janela de 1s) -> soma dos
--     counts retornados é sequencial e sem duplicata (prova de que o
--     upsert serializa as duas chamadas, não perde nem duplica
--     incremento).
--  5. Aguardar o window_ms expirar (ex.: chamar com p_window_ms=1000 e
--     esperar >1s) -> próxima chamada reinicia count=1 com novo
--     reset_at, não acumula com o valor antigo.
--  6. Como authenticated (client RLS-scoped): SELECT * FROM
--     rate_limit_buckets -> 0 linhas (RLS nega, não erro). rpc('rate_
--     limit_check', ...) -> REJEITADO (sem EXECUTE), não retorna dado
--     de nenhuma chave de outro usuário/conta.
--  7. Confirmar que uma chamada com p_key já expirado há muito tempo
--     (ex.: reset_at de dias atrás) sobrevive à limpeza oportunista
--     sem erro — a IF random() < 0.005 é probabilística, não precisa
--     disparar em todo teste, só confirmar que quando dispara o
--     DELETE não afeta a linha que acabou de ser upsertada nesta mesma
--     chamada (o DELETE roda depois do RETURNING já ter capturado o
--     valor a devolver).
--
-- ---- search_path / qualificação de schema (revisão) ----
--  8. SELECT prosecdef, proconfig FROM pg_proc WHERE proname =
--     'rate_limit_check' -> prosecdef = true, proconfig contém
--     'search_path=' (vazio).
--  9. grep no corpo da função (pg_get_functiondef) por 'rate_limit_
--     buckets' sem o prefixo 'public.' imediatamente antes -> zero
--     ocorrências (toda referência deve vir como
--     'public.rate_limit_buckets').
-- 10. Como um role de teste com permissão de criar objetos temporários
--     (não authenticated/anon — esses nem têm EXECUTE): CREATE TEMP
--     TABLE rate_limit_buckets (key text, count int, reset_at
--     timestamptz); depois SELECT * FROM rate_limit_check('smoke:2',
--     3, 60000) na mesma sessão -> a linha resultante aparece em
--     public.rate_limit_buckets (SELECT * FROM public.
--     rate_limit_buckets WHERE key = 'smoke:2'), NUNCA na tabela
--     temporária — confirma que pg_temp não conseguiu interceptar.
--
-- ---- validação de entrada (revisão) ----
-- 11. SELECT * FROM rate_limit_check(NULL, 3, 60000) -> ERRO
--     (p_key must not be null...), SQLSTATE 22023.
-- 12. SELECT * FROM rate_limit_check('', 3, 60000) -> ERRO (mesmo
--     código). SELECT * FROM rate_limit_check('   ', 3, 60000) -> ERRO
--     (só espaço também rejeitado).
-- 13. SELECT * FROM rate_limit_check(repeat('a', 513), 3, 60000) ->
--     ERRO (p_key must be at most 512 characters). repeat('a', 512)
--     (exatamente no teto) -> permitido normalmente.
-- 14. SELECT * FROM rate_limit_check('smoke:3', 0, 60000) -> ERRO
--     (p_limit must be a positive integer). Idem para -1. SELECT *
--     FROM rate_limit_check('smoke:3', 100001, 60000) -> ERRO (must
--     not exceed 100000). 100000 exato -> permitido.
-- 15. SELECT * FROM rate_limit_check('smoke:4', 3, 0) -> ERRO
--     (p_window_ms must be a positive integer). Idem para -1000.
--     SELECT * FROM rate_limit_check('smoke:4', 3, 86400001) -> ERRO
--     (must not exceed 86400000). 86400000 exato -> permitido.
-- 16. Confirmar que NENHUM dos casos 11-15 chega a executar o INSERT
--     (SELECT count(*) FROM public.rate_limit_buckets WHERE key IN
--     ('', '   ', repeat('a',513), 'smoke:3', 'smoke:4') antes e
--     depois dos testes acima que devem falhar -> nenhuma linha nova
--     dessas chaves rejeitadas).
-- 17. Confirmar que os 12 buckets reais de RATE_LIMITS (src/lib/
--     rate-limit.ts) continuam dentro dos novos tetos: todos os
--     limites (5 a 120) « 100000, e a única janela usada (60000ms)
--     « 86400000 — nenhuma chamada legítima do TypeScript passa a
--     falhar por causa desta revisão.
-- ============================================================
