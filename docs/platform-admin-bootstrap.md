# Bootstrap do primeiro Superadmin da plataforma

Este documento descreve o procedimento manual, único, para criar o
**primeiro** Superadmin (`public.platform_admins`) em um deploy do
WACRM. Não existe automação para isso — de propósito.

## Por que não é automático

`grant_platform_admin(target_user_id)` (ver
`supabase/migrations/046_platform_admin_foundation.sql`) só pode ser
chamada por quem **já é** platform admin. Antes do primeiro bootstrap
não existe nenhum, então essa RPC não pode ser usada para criar o
primeiro registro — seria um paradoxo de "preciso já ser admin para
virar admin".

Da mesma forma, o signup público (`/signup`) nunca cria um platform
admin automaticamente, e a migration `046_platform_admin_foundation.sql`
nunca insere nenhuma linha em `platform_admins` por si só — nenhum
usuário, e-mail ou UUID fica hardcoded em nenhuma migration deste
repositório. O bootstrap é sempre uma decisão humana, feita uma vez,
fora do fluxo normal da aplicação.

## Pré-requisito

O usuário que vai virar o primeiro Superadmin precisa já existir em
`auth.users` — ou seja, precisa ter feito login pelo menos uma vez
(signup normal, como qualquer outro usuário do WACRM). O bootstrap
**não cria** o usuário, só concede o escopo de plataforma a um
usuário que já existe.

## Procedimento recomendado

1. Peça para a pessoa que vai ser a primeira Superadmin criar sua
   conta normalmente (signup padrão do WACRM). Isso cria a linha dela
   em `auth.users` e, como efeito colateral do trigger de signup, uma
   conta pessoal comum em `accounts` — irrelevante para o bootstrap,
   pode ficar como está ou ser tratada depois nas fases seguintes.

2. Descubra o `id` (UUID) dessa pessoa em `auth.users` — pelo painel
   do Supabase Studio (Authentication → Users) ou por uma consulta
   pontual no SQL Editor filtrando pelo e-mail dela. Não anote nem
   compartilhe esse UUID fora de um canal já autorizado para dados de
   produção.

3. No SQL Editor do Supabase (ou em outro ambiente administrativo
   equivalente com acesso direto ao Postgres, nunca pela aplicação),
   execute — substituindo `<UUID_DO_USUARIO>` pelo UUID real, sem
   deixá-lo em nenhum arquivo versionado:

   ```sql
   -- Passo 1: concede o escopo de plataforma.
   INSERT INTO public.platform_admins (user_id, created_by)
   VALUES ('<UUID_DO_USUARIO>', '<UUID_DO_USUARIO>');

   -- Passo 2: registra o bootstrap na auditoria. actor_user_id é o
   -- próprio usuário bootstrapado (não existe "quem concedeu" ainda,
   -- já que ele é o primeiro) — a distinção fica em metadata.
   INSERT INTO public.platform_audit_log (actor_user_id, action, target_user_id, metadata)
   VALUES ('<UUID_DO_USUARIO>', 'platform_admin.bootstrap', '<UUID_DO_USUARIO>', '{"bootstrap": true}'::jsonb);
   ```

   Essas duas instruções rodam fora de qualquer RPC — é a única
   situação em que uma inserção direta em `platform_admins`/
   `platform_audit_log` é esperada, porque só o operador com acesso
   direto ao Postgres (dono da tabela, não sujeito a RLS) consegue
   fazer isso; nenhum client autenticado da aplicação tem esse
   caminho.

4. A partir daqui, esse usuário já passa em
   `requirePlatformAdmin()`/`is_platform_admin()` e pode usar
   `grant_platform_admin`/`revoke_platform_admin` normalmente para
   conceder acesso de plataforma a outras pessoas — o bootstrap manual
   só é necessário uma vez por deploy.

## O que nunca fazer

- Nunca commitar um UUID, e-mail ou qualquer identificador real de
  usuário de produção neste repositório (nem neste arquivo, nem em
  migration, nem em issue/PR).
- Nunca hardcodar um usuário "padrão" de Superadmin em nenhuma
  migration — cada deploy (incluindo ambientes de teste) faz o
  próprio bootstrap.
- Nunca conceder platform admin a partir de uma rota da aplicação
  sem passar por `grant_platform_admin` (que exige chamador já
  autorizado) — a única exceção documentada é este bootstrap manual,
  único, feito fora da aplicação.
