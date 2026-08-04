# Progresso — Webhook de recebimento UAZAPI

> Documento de continuidade. Não contém tokens, segredos, HMAC, URLs completas, instanceId/accountId completos, cookies ou valores de headers sensíveis — apenas nomes, status HTTP, decisões técnicas e identificadores mascarados.

## Status atual

**Webhook de recebimento habilitado e funcionando.** Uma mensagem de texto real, enviada de outro WhatsApp para o número conectado, foi recebida pelo webhook, persistida no CRM (contato, conversa e mensagem) e apareceu corretamente na Caixa de entrada. O bloqueio original de `POST /webhook` (401 persistente — ver "Histórico: bloqueio original" abaixo) foi superado: a causa raiz era o campo `enabled` do corpo do registro do webhook, que a UAZAPI assume como `false` por padrão quando omitido — `configureWebhook()` agora envia `enabled: true` explicitamente.

Resumido:
- **Envio** — texto, imagem e PDF via UAZAPI: ✅ funcional (sessão anterior).
- **Registro do webhook** (`POST /api/uazapi/webhook/register`) — ✅ funcional, `enabled: true` corrigido.
- **Recebimento (texto, chat individual)** — ✅ funcional, mensagem real confirmada na Caixa de entrada.
- **Mídia (imagem/áudio/vídeo/documento) recebida** — ❌ ainda não implementada.
- **Localização, grupos, respostas citadas, status updates recebidos** — ❌ ainda não implementados.
- **Tickets/filas/setores** — ❌ ainda não implementados (fora do escopo desta frente; ver conversa sobre análise geral do CRM).

## Payload real do evento `messages` (mapeado)

Envelope de raiz confirmado (sem `data`, diferente do que a documentação pública sugeria):

```
{ EventType, chat, chatSource, message, instanceName, owner, BaseUrl, token }
```

Campos usados de `message`: `messageid`, `id`, `chatid`, `sender`, `senderName`, `sender_pn`, `fromMe`, `messageType`, `messageTimestamp`, `status`, `text`, `isGroup`, `wasSentByApi`, `content`.

Campos usados de `chat`: `phone`, `name`, `lead_name`, `lead_fullName`, `wa_contactName`, `wa_chatid`, `wa_isGroup`.

`instanceName`, `owner`, `BaseUrl` e `token` (a própria credencial da instância, ecoada de volta pela UAZAPI dentro do corpo do evento) nunca são lidos pelo parser.

## Persistência (texto, chat individual)

- **Parser puro** (`src/lib/whatsapp/uazapi-webhook-parser.ts`) — valida e extrai `externalMessageId`, `phone`, `name`, `text`, `occurredAt`; retorna `null` para grupos, `fromMe`, ecos da própria API, tipos não-texto ou payload inválido. Sem I/O.
- **Persistência** (`src/lib/whatsapp/uazapi-webhook-persist.ts`) — find-or-create de contato/conversa (mesmo padrão do webhook Meta) + uma única chamada RPC (`uazapi_persist_inbound_text_message`) que insere a mensagem e avança a conversa (`unread_count`, `last_message_text`, `last_message_at`) atomicamente, com guarda de conflito em `(conversation_id, message_id)`.
- **Migration 038** (`supabase/migrations/038_uazapi_message_dedup.sql`) — **aplicada**. Índice único `idx_messages_conversation_message_id`, função `public.uazapi_persist_inbound_text_message` (`SECURITY INVOKER`, só `service_role` pode executar), checagem de duplicidade pré-existente antes de criar o índice (não encontrou nenhuma).
- **Rota** (`src/app/api/uazapi/webhook/[instanceId]/[hmac]/route.ts`) — responde `200 {status:'ignored'|'persisted'|'duplicate'}` ou `503 {error:'persistence_failed'}` (nunca 200 numa falha real, para permitir retry legítimo da UAZAPI). Logs reduzidos ao mínimo estrutural: `ignored` / `persisted` / `duplicate` / `persistence_failed` + `instanceId` mascarado — nunca telefone, nome, texto, payload, URL, token, HMAC ou IDs completos.
- Os módulos temporários de descoberta de shape (`uazapi-webhook-sanitizer.ts`, `uazapi-webhook-diagnostics.ts`), usados só para mapear o payload real antes do parser existir, foram removidos.

## Pendências conhecidas

1. **Mídia recebida** (imagem/áudio/vídeo/documento) — não implementada. Precisa de download/verificação do arquivo antes de persistir `media_url`.
2. **Tickets/filas/setores por cor de tag** — não implementado; discutido separadamente como melhoria geral do CRM (multi-empresa já existe via `accounts`; falta o conceito de fila/departamento).
3. **Quick Tunnel é temporário** — `cloudflared tunnel --url http://localhost:3000` não é persistente. Toda vez que o processo for reiniciado, a URL pública muda e é necessário rodar `POST /api/uazapi/webhook/register` de novo com a nova `baseUrl` antes de qualquer teste real.

---

## Histórico: bloqueio original (resolvido)

As seções abaixo documentam a investigação da sessão em que `POST /webhook` retornava 401 persistente — mantidas para contexto, já resolvidas.

### Diagnóstico

- 401 persistente com as duas credenciais conhecidas (`token`/instance e `admintoken`/admin) — todas as outras chamadas instance-scoped funcionavam normalmente com `token`.
- Hipóteses descartadas: header errado (testado, mesmo 401); token de instância desatualizado (mesmo token funcionava em outras rotas); divergência de servidor (mesma URL usada com sucesso em outras chamadas); campos `enabled`/`webhookByEvents`/`webhookBase64` como usados por outro produto (Evolution API, não UAZAPI).
- **Causa raiz real, encontrada depois**: não era o 401 em si que impedia o recebimento — o registro do webhook (`POST /webhook`) **retornava sucesso**, mas com `enabled` assumindo `false` por padrão (confirmado no schema `Webhook` de uma spec OpenAPI pública de referência), então a UAZAPI nunca disparava eventos para uma URL registrada mas desabilitada. A correção foi enviar `enabled: true` explicitamente em `configureWebhook()`.

### Testes desta investigação

| Teste | Resultado |
|---|---|
| Envio de texto/imagem/PDF via UAZAPI | ✅ sucesso |
| Persistência das mensagens enviadas no histórico | ✅ sucesso |
| `POST /api/uazapi/webhook/register` sem `enabled: true` | ❌ registrava, mas webhook ficava desabilitado |
| `POST /api/uazapi/webhook/register` com `enabled: true` | ✅ webhook habilitado, evento real recebido |
| `GET /webhook` (consulta de configuração) | ✅ confirmou `enabled: false` antes da correção, depois `true` |
