import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for account-scoped routes that need
// admin.auth.admin.* (never reachable via RLS). Mirrors the identical
// pattern in src/lib/{automations,queues,flows,platform}/admin-client.ts.
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
