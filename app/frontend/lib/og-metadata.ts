import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * SSR OG metadata fetching with Redis caching + revalidation.
 *
 * - Cache key: og:{username}:{amount}:{asset}
 * - TTL: 60s (Redis)
 * - Stale fallback when the backend is unavailable
 * - Cache-Control: s-maxage=60, stale-while-revalidate
 * - Revalidation on `payment-link.updated`
 */

export interface OgMetadata {
  username: string;
  amount: string;
  asset: string;
  title: string;
  description: string;
  image?: string;
}

export interface OgMetadataParams {
  username: string;
  amount: string;
  asset: string;
}

const OG_CACHE_TTL_SECONDS = 60;
const OG_CACHE_PREFIX = 'og';
const OG_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ??
  process.env.BACKEND_URL ??
  'http://localhost:3001';

const REDIS_URL = process.env.REDIS_URL;

/**
 * Minimal Redis client surface. We only need GET/SETEX/DEL, so we avoid
 * pulling in a hard dependency and instead use the REST-friendly Upstash
 * client when configured, falling back to an in-memory map for local dev.
 */
interface RedisLike {
  get(key: string): Promise<string | null>;
  setex(key: string, ttl: number, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

const memoryStore = new Map<string, { value: string; expiresAt: number }>();

const memoryRedis: RedisLike = {
  async get(key) {
    const entry = memoryStore.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      memoryStore.delete(key);
      return null;
    }
    return entry.value;
  },
  async setex(key, ttl, value) {
    memoryStore.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return 'OK';
  },
  async del(key) {
    memoryStore.delete(key);
    return 1;
  },
};

let redisClient: RedisLike | null = null;

function getRedis(): RedisLike {
  if (redisClient) return redisClient;

  if (REDIS_URL) {
    try {
      // Lazy require so the module stays usable in environments without Redis.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Redis } = require('@upstash/redis');
      const client = new Redis({ url: REDIS_URL, token: process.env.REDIS_TOKEN });
      redisClient = {
        get: (key: string) => client.get<string>(key),
        setex: (key: string, ttl: number, value: string) =>
          client.set(key, value, { ex: ttl }),
        del: (key: string) => client.del(key),
      };
      return redisClient;
    } catch {
      // Fall through to the in-memory store when the client is unavailable.
    }
  }

  redisClient = memoryRedis;
  return redisClient;
}

export function buildOgCacheKey({ username, amount, asset }: OgMetadataParams): string {
  return `${OG_CACHE_PREFIX}:${username}:${amount}:${asset}`;
}

async function fetchOgMetadataFromBackend(
  params: OgMetadataParams,
): Promise<OgMetadata | null> {
  const { username, amount, asset } = params;
  const url = `${BACKEND_URL}/api/og/${encodeURIComponent(username)}?amount=${encodeURIComponent(
    amount,
  )}&asset=${encodeURIComponent(asset)}`;

  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<OgMetadata>;
    return {
      username,
      amount,
      asset,
      title: data.title ?? `Pay ${username}`,
      description: data.description ?? `Send ${amount} ${asset} to ${username}`,
      image: data.image,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve OG metadata for SSR, preferring the Redis cache and falling back to
 * the last known good value when the backend is unreachable.
 */
export async function getOgMetadata(params: OgMetadataParams): Promise<OgMetadata> {
  const key = buildOgCacheKey(params);
  const redis = getRedis();

  const cached = await redis.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as OgMetadata;
    } catch {
      // Corrupt cache entry — ignore and refetch.
    }
  }

  const fresh = await fetchOgMetadataFromBackend(params);
  if (fresh) {
    await redis.setex(key, OG_CACHE_TTL_SECONDS, JSON.stringify(fresh));
    return fresh;
  }

  // Backend is down: serve stale metadata if we have any, otherwise a safe default.
  const stale = await redis.get(`${key}:stale`);
  if (stale) {
    try {
      return JSON.parse(stale) as OgMetadata;
    } catch {
      // fall through to default
    }
  }

  return {
    username: params.username,
    amount: params.amount,
    asset: params.asset,
    title: `Pay ${params.username}`,
    description: `Send ${params.amount} ${params.asset} to ${params.username}`,
  };
}

/**
 * Persist a long-lived stale copy so we can still render metadata when the
 * backend is unavailable. Called alongside the fresh cache write.
 */
export async function cacheOgMetadata(params: OgMetadataParams, metadata: OgMetadata): Promise<void> {
  const key = buildOgCacheKey(params);
  const redis = getRedis();
  await redis.setex(key, OG_CACHE_TTL_SECONDS, JSON.stringify(metadata));
  await redis.setex(`${key}:stale`, 60 * 60 * 24, JSON.stringify(metadata));
}

/**
 * Invalidate cached OG metadata for a payment link. Wire this into the
 * `payment-link.updated` event handler so SSR picks up fresh values.
 */
export async function revalidateOgMetadata(params: OgMetadataParams): Promise<void> {
  const key = buildOgCacheKey(params);
  const redis = getRedis();
  await redis.del(key);
}

/**
 * Next.js API route handler that emits OG metadata with the required
 * Cache-Control header so Vercel's Edge Cache can serve it.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const username = String(req.query.username ?? '');
  const amount = String(req.query.amount ?? '');
  const asset = String(req.query.asset ?? '');

  if (!username || !amount || !asset) {
    res.status(400).json({ error: 'username, amount and asset are required' });
    return;
  }

  const metadata = await getOgMetadata({ username, amount, asset });

  res.setHeader('Cache-Control', OG_CACHE_CONTROL);
  res.setHeader('Vercel-CDN-Cache-Control', OG_CACHE_CONTROL);
  res.status(200).json(metadata);
}
