import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Client service-role compartilhado e lazy para ler/escrever
// user_permission_overrides. Espelha o padrão idêntico em
// src/lib/{account,ai,automations,flows,internal-tickets,platform,queues}/admin-client.ts
// — a tabela não tem policies de RLS para authenticated/anon (mesmo
// desenho de platform_admins), então todo acesso passa por este
// client a partir de código server-only, nunca de um componente
// "use client".
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
