import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for internal-tickets settings
// routes (052-INT-B). Mirrors the identical pattern in
// src/lib/queues/admin-client.ts, src/lib/automations/admin-client.ts,
// src/lib/flows/admin-client.ts, and src/lib/ai/admin-client.ts.
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
