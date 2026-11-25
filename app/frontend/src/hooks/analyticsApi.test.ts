import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAnalyticsCache, fetchAnalytics } from './analyticsApi';

function mockReport(totalVolumeUsd: number) {
  return {
    summary: {
      totalTransactions: 10,
      successfulTransactions: 10,
      failedTransactions: 0,
      conversionRate: 100,
      totalVolumeUsd,
      averageTransactionUsd: totalVolumeUsd / 10,
    },
    assetDistribution: [],
    timeSeries: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('fetchAnalytics account-scoped caching', () => {
  const PUBLIC_KEY_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB';
  const PUBLIC_KEY_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBC';

  beforeEach(() => {
    clearAnalyticsCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('caches reports separately per account, not just per range', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const totalVolumeUsd = url.includes(encodeURIComponent(PUBLIC_KEY_A)) ? 100 : 200;
      return {
        ok: true,
        json: async () => mockReport(totalVolumeUsd),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const resultA = await fetchAnalytics('30d', PUBLIC_KEY_A);
    const resultB = await fetchAnalytics('30d', PUBLIC_KEY_B);

    expect(resultA.summary.totalVolume).toBe(100);
    expect(resultB.summary.totalVolume).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Second call per account must hit the cache, not refetch.
    await fetchAnalytics('30d', PUBLIC_KEY_A);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a slow request for one account never overwrites another account's cached entry", async () => {
    const slowA = deferred<Response>();
    const fetchMock = vi.fn((url: string) => {
      if (url.includes(encodeURIComponent(PUBLIC_KEY_A))) {
        return slowA.promise;
      }
      return Promise.resolve({ ok: true, json: async () => mockReport(50) } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);

    const pendingA = fetchAnalytics('30d', PUBLIC_KEY_A);
    // Account B's request starts after A but resolves first (A is still in flight).
    const resultB = await fetchAnalytics('30d', PUBLIC_KEY_B);
    expect(resultB.summary.totalVolume).toBe(50);

    slowA.resolve({ ok: true, json: async () => mockReport(999) } as Response);
    const resultA = await pendingA;
    expect(resultA.summary.totalVolume).toBe(999);

    // B's cached entry must be untouched by A resolving afterwards.
    const resultBAgain = await fetchAnalytics('30d', PUBLIC_KEY_B);
    expect(resultBAgain.summary.totalVolume).toBe(50);
  });

  it('clearAnalyticsCache wipes every cached account+range entry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => mockReport(1) }) as Response),
    );

    await fetchAnalytics('30d', PUBLIC_KEY_A);
    clearAnalyticsCache();

    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => mockReport(2) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    await fetchAnalytics('30d', PUBLIC_KEY_A);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
