import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Cliente service_role para as rotas /api/admin/**. Só deve ser
// usado DEPOIS de requirePlatformAdmin() já ter autorizado o
// chamador — este client, sozinho, ignora RLS por completo e enxerga
// todas as contas. Mesmo padrão de
// src/lib/{automations,queues,flows}/admin-client.ts.
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
