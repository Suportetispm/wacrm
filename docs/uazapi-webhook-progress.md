# Progresso — Webhook de recebimento UAZAPI

> Documento de continuidade. Não contém tokens, segredos, HMAC, URLs completas, instanceId/accountId completos, cookies ou valores de headers sensíveis — apenas nomes, status HTTP, decisões técnicas e identificadores mascarados.

## Objetivo atual

Implementar o recebimento de mensagens de clientes via webhook UAZAPI, para complementar o envio (já funcional: texto, imagem e PDF testados com sucesso, `provider` ativo = `uazapi`).

## Etapas concluídas

1. **Envio pelo CRM (concluído e testado)** — texto, imagem e PDF enviados com sucesso via UAZAPI; mensagens salvas corretamente no histórico.
2. **"Nova conversa" na Caixa de entrada (concluído)** — botão + modal para iniciar atendimento manualmente (contato existente ou novo, telefone canônico `+<dígitos>`, sem duplicidade), composer liberado para texto simples sem exigir template Meta quando `provider==='uazapi'`.
3. **Planejamento do webhook de recebimento** — análise completa do webhook Meta existente (contatos, conversas, mensagens, mídia, idempotência, isolamento por conta) como referência de padrão.
4. **Segurança do webhook (concluído)** — mecanismo de autenticação via HMAC (`UAZAPI_WEBHOOK_SECRET` + `uazapi_instance_id`, recalculado por request, nunca armazenado — sem migration).
5. **Rota de captura temporária (concluída)** — recebe e valida (HTTPS, Content-Type, tamanho, HMAC), mas **não persiste nada** — só loga uma representação estrutural sanitizada do payload (tipos/tamanhos/contagens, nunca valores).
6. **Rota de registro do webhook (criada, não executada com sucesso ainda)** — endpoint autenticado (`requireRole('admin')`) que monta a URL completa só em memória e chama `configureWebhook()`.
7. **Instalação do `cloudflared`** via `winget` — concluída.
8. **Túnel Quick Tunnel** — foi ativado uma vez durante a sessão (ver "Estado atual do túnel" abaixo).
9. **Diagnóstico de autenticação do `configureWebhook()`** — duas hipóteses testadas e descartadas (ver "Hipóteses descartadas").

## Arquivos criados nesta sessão (UAZAPI, ao longo de todas as etapas)

- `src/lib/whatsapp/uazapi-webhook-auth.ts` — `computeUazapiWebhookToken` / `verifyUazapiWebhookToken` (HMAC).
- `src/lib/whatsapp/uazapi-webhook-sanitizer.ts` — sanitizador estrutural para a captura temporária.
- `src/app/api/uazapi/webhook/[instanceId]/[hmac]/route.ts` — rota de **captura temporária** (não persiste).
- `src/app/api/uazapi/webhook/register/route.ts` — rota autenticada de **registro** do webhook na UAZAPI.
- `src/components/inbox/new-conversation-modal.tsx` — modal "Nova conversa".

## Arquivos alterados nesta sessão

- `.env.local.example` — placeholder comentado de `UAZAPI_WEBHOOK_SECRET` (sem valor real).
- `src/app/(dashboard)/inbox/page.tsx` — estado do modal "Nova conversa", `activeProvider`.
- `src/app/api/uazapi/connect/route.ts` — classificação de erro `instance_invalid` (401/403/404 da UAZAPI).
- `src/app/api/uazapi/status/route.ts` — idem.
- `src/components/inbox/conversation-list.tsx` — botão "Nova conversa".
- `src/components/inbox/message-composer.tsx` — prop `allowTemplates`.
- `src/components/inbox/message-thread.tsx` — `sessionInfo` provider-aware (sem janela de 24h para UAZAPI), prop `provider`.
- `src/components/settings/whatsapp-config.tsx` — fluxo completo de criar/reconectar/recriar instância UAZAPI, gate Meta vs UAZAPI.
- `src/lib/inbox/conversations.ts` — `findOrCreateConversationForContact` (com recuperação de unique violation).
- `src/lib/whatsapp/uazapi-api.ts` — `UazapiHttpError` (preserva status HTTP real); `configureWebhook()` passou por duas tentativas de correção e foi **revertido** ao estado original (ver abaixo).

## Testes já realizados e resultados

| Teste | Resultado |
|---|---|
| Envio de texto via UAZAPI | ✅ sucesso |
| Envio de imagem via UAZAPI | ✅ sucesso |
| Envio de PDF via UAZAPI | ✅ sucesso |
| Persistência das mensagens enviadas no histórico | ✅ sucesso |
| `cloudflared --version` (pós-instalação) | ✅ `2026.7.3` |
| `POST /api/uazapi/webhook/register` — tentativa 1 (header `token` + instance token) | ❌ rota local `502`, status externo UAZAPI **401** |
| `POST /api/uazapi/webhook/register` — tentativa 2 (header `admintoken` + admin token) | ❌ rota local `502`, status externo UAZAPI **401** |
| `npx tsc --noEmit` (checagem final da sessão) | ✅ passou |
| `npx eslint` nos arquivos alterados (checagem final) | ✅ passou, 0 erros, 6 avisos pré-existentes de estilo (não bloqueantes) |

## Erros encontrados

- **401 persistente em `POST /webhook`** com as duas credenciais conhecidas do projeto (`token`/instance e `admintoken`/admin). Todas as outras chamadas instance-scoped (`/instance/connect`, `/instance/status`, `/send/text`, `/send/media`) funcionam normalmente com `token`.

## Hipóteses descartadas

1. ~~`configureWebhook()` usa o header errado (deveria ser `admintoken`, não `token`)~~ — testado, também deu 401. Descartada como causa isolada.
2. ~~Token de instância desatualizado (stale) após recriação~~ — descartada: o mesmo token funciona em todas as outras chamadas instance-scoped, lido sempre fresco do banco.
3. ~~Divergência de servidor (`UAZAPI_SERVER_URL` diferente do servidor onde a instância foi criada)~~ — improvável: mesma URL de servidor usada com sucesso em todas as outras chamadas de instância.
4. Campos como `enabled`/`webhookByEvents`/`webhookBase64` — **não são da UAZAPI**, confirmados pertencerem a um produto diferente (Evolution API) encontrado durante a busca; descartados como fonte de referência.

## Contexto relevante não resolvido

- O servidor configurado (`UAZAPI_SERVER_URL`) é um **subdomínio próprio/dedicado**, não o servidor de teste público gratuito mencionado no `.env.local.example`. Instâncias dedicadas/self-hosted podem divergir da API genérica documentada publicamente — reforça a suspeita de que o contrato real de `/webhook` nesse servidor específico é diferente do assumido.
- `events: ['messages']` continua **não confirmado** contra nenhuma fonte oficial acessível (site de docs é uma SPA sem conteúdo extraível via fetch; `/openapi.json`, `/swagger.json` e `/docs` no servidor ao vivo retornaram 404 ou redirecionamento sem schema).

## Estado atual do túnel

O Quick Tunnel (`cloudflared tunnel --url http://localhost:3000`) foi usado durante os testes de registro desta sessão. **Não presuma que ele continua ativo** — Quick Tunnels não são persistentes; se o processo do `cloudflared` foi encerrado (ex.: fechamento do terminal), a URL pública gerada não existe mais e uma nova precisará ser gerada na retomada. Nenhuma URL foi salva em nenhum arquivo do projeto.

## Pendência exata para a próxima sessão

Ainda não identificamos o contrato real de autenticação/payload do endpoint de configuração de webhook nesta instância UAZAPI específica (dedicada). `configureWebhook()` está **revertido** ao estado original (header `token` + `instanceToken`), aguardando confirmação real antes de qualquer nova tentativa.

## Próximo passo recomendado

Observar, pelo próprio painel web da instância UAZAPI (login do usuário, fora do alcance deste assistente), a aba Network do DevTools ao salvar uma configuração de webhook pela interface oficial — capturando **somente** método HTTP, path, nomes de headers, `Content-Type`, nomes dos campos do corpo e status HTTP da resposta (nunca valores). Esse é o próximo passo já proposto e ainda não executado (etapa 8.1I), pendente de o usuário realizá-lo e reportar os campos não sensíveis observados.
