import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const router = Router();

let supabase: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient | null {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabase;
}

type DependencyState = 'up' | 'down' | 'unconfigured';

interface DependencyReport {
  name: string;
  critical: boolean;
  state: DependencyState;
}

async function checkSupabase(): Promise<DependencyReport> {
  const client = getSupabaseClient();
  if (!client) {
    return { name: 'supabase', critical: true, state: 'unconfigured' };
  }
  try {
    // Lightweight connectivity probe; never surfaces connection details.
    const { error } = await client.from('health_check').select('id').limit(1);
    if (error && error.code !== 'PGRST116' && error.code !== '42P01') {
      return { name: 'supabase', critical: true, state: 'down' };
    }
    return { name: 'supabase', critical: true, state: 'up' };
  } catch {
    return { name: 'supabase', critical: true, state: 'down' };
  }
}

// Liveness: process is running. Must stay available during dependency outages.
router.get('/live', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'alive' });
});

// Readiness: process can serve traffic, reflecting critical dependency state.
router.get('/ready', async (_req: Request, res: Response) => {
  const dependencies: DependencyReport[] = [await checkSupabase()];
  const criticalDown = dependencies.some(
    (dep) => dep.critical && dep.state !== 'up'
  );

  const status = criticalDown ? 'degraded' : 'ready';
  res.status(criticalDown ? 503 : 200).json({
    status,
    dependencies: dependencies.map((dep) => ({
      name: dep.name,
      critical: dep.critical,
      state: dep.state,
    })),
  });
});

// Backwards-compatible aggregate health endpoint.
router.get('/', async (_req: Request, res: Response) => {
  const dependencies: DependencyReport[] = [await checkSupabase()];
  const criticalDown = dependencies.some(
    (dep) => dep.critical && dep.state !== 'up'
  );

  res.status(criticalDown ? 503 : 200).json({
    status: criticalDown ? 'degraded' : 'ok',
    dependencies: dependencies.map((dep) => ({
      name: dep.name,
      critical: dep.critical,
      state: dep.state,
    })),
  });
});

export default router;
