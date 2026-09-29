import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const OG_CACHE_TTL_SECONDS = 60;

function ogCacheKey(username: string, amount: string, asset: string): string {
  return `og:${username}:${amount}:${asset}`;
}

/**
 * Revalidation webhook for payment-link.updated events.
 *
 * Invalidates the SSR OG metadata cache (Redis + Vercel Edge Cache) so the
 * next request regenerates fresh metadata for the affected payment link.
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-revalidate-secret');
  if (!process.env.REVALIDATE_SECRET || secret !== process.env.REVALIDATE_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: {
    event?: string;
    username?: string;
    amount?: string | number;
    asset?: string;
  };

  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (payload.event !== 'payment-link.updated') {
    return NextResponse.json({ error: 'Unsupported event' }, { status: 400 });
  }

  const { username, amount, asset } = payload;
  if (!username || amount === undefined || !asset) {
    return NextResponse.json(
      { error: 'Missing username, amount, or asset' },
      { status: 400 },
    );
  }

  const key = ogCacheKey(username, String(amount), asset);

  try {
    await redis.del(key);
  } catch {
    // Redis may be unavailable; still invalidate the edge cache below.
  }

  revalidateTag(`og:${username}`);

  return NextResponse.json({
    revalidated: true,
    key,
    ttl: OG_CACHE_TTL_SECONDS,
    now: Date.now(),
  });
}
