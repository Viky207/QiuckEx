import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/**
 * Returns the shared Supabase client, or null when the dependency is not
 * configured. Never throws and never surfaces the connection string.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (client) {
    return client;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    return null;
  }

  client = createClient(url, key, {
    auth: { persistSession: false },
  });

  return client;
}

export type SupabaseDependencyState = 'ok' | 'degraded' | 'unconfigured';

export interface SupabaseDependencyStatus {
  name: 'supabase';
  critical: true;
  state: SupabaseDependencyState;
  /** Human-readable reason; never contains connection strings or secrets. */
  detail?: string;
}

/**
 * Probes the Supabase persistence dependency for readiness reporting.
 *
 * Liveness must not depend on this: a process can be live while Supabase is
 * unavailable. Readiness uses this result to report an explicit degraded
 * state instead of silently claiming to be ready.
 */
export async function checkSupabaseDependency(): Promise<SupabaseDependencyStatus> {
  const supabase = getSupabaseClient();

  if (!supabase) {
    return {
      name: 'supabase',
      critical: true,
      state: 'unconfigured',
      detail: 'Supabase is not configured',
    };
  }

  try {
    const { error } = await supabase.from('health_check').select('id').limit(1);

    if (error) {
      return {
        name: 'supabase',
        critical: true,
        state: 'degraded',
        detail: 'Supabase query failed',
      };
    }

    return {
      name: 'supabase',
      critical: true,
      state: 'ok',
    };
  } catch {
    return {
      name: 'supabase',
      critical: true,
      state: 'degraded',
      detail: 'Supabase is unreachable',
    };
  }
}
