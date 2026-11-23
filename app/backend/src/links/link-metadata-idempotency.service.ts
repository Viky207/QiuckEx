import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import type { LinkMetadataRequestDto, LinkMetadataResponseDto } from '../dto';

/** A replay window long enough to cover slow responses and client timeouts. */
export const LINK_METADATA_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

/** Bound the process-local cache so replay protection cannot grow without limit. */
export const LINK_METADATA_IDEMPOTENCY_MAX_ENTRIES = 500;

/** Matches the existing url-safe idempotency key convention used elsewhere in the API. */
export const LINK_METADATA_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type LinkMetadataIdempotencyLookup =
  | { status: 'miss' }
  | { status: 'hit'; response: LinkMetadataResponseDto }
  | { status: 'conflict' };

export type LinkMetadataIdempotencyRun =
  | { status: 'conflict' }
  | { status: 'ok'; response: LinkMetadataResponseDto };

type CacheEntry = {
  fingerprint: string;
  response: LinkMetadataResponseDto;
  expiresAt: number;
};

type InFlightEntry = {
  fingerprint: string;
  promise: Promise<LinkMetadataResponseDto>;
};

/**
 * Deterministic, one-way fingerprint of the validated metadata request. Object
 * key order and `undefined` fields are ignored so semantically identical
 * payloads share a replay key. The SHA-256 digest is the only value retained:
 * raw request values (including public keys) are never stored or logged.
 */
export function fingerprintLinkMetadataRequest(request: LinkMetadataRequestDto): string {
  return createHash('sha256').update(stableStringify(request)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();

  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

/**
 * Process-local replay guard for `POST /links/metadata`.
 *
 * Link metadata generation is stateless, so a replay never duplicates a
 * persisted link or moves funds. Two mechanisms make retries safe:
 *  1. In-flight requests with the same key are coalesced, so a retry that
 *     arrives while the original is still processing waits for its result.
 *  2. Completed successes are cached so a retry after a timeout returns the
 *     exact original response (including `expiresAt`) without regenerating it.
 *
 * Entries expire and both maps are bounded; a restart clears them safely
 * because the operation itself is stateless. No secret, signature, or
 * unnecessary personal data is stored or logged.
 */
@Injectable()
export class LinkMetadataIdempotencyService {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightEntry>();

  isValidKey(key?: string | null): key is string {
    return typeof key === 'string' && LINK_METADATA_IDEMPOTENCY_KEY_PATTERN.test(key);
  }

  lookup(key: string, fingerprint: string): LinkMetadataIdempotencyLookup {
    const now = Date.now();
    this.prune(now);

    const entry = this.entries.get(key);
    if (!entry) {
      return { status: 'miss' };
    }
    if (entry.fingerprint !== fingerprint) {
      return { status: 'conflict' };
    }

    return { status: 'hit', response: entry.response };
  }

  /**
   * Single entry point used by the controller. Replays an in-flight or cached
   * success, reports a payload conflict, otherwise runs `generate` once and
   * remembers the successful result. Failed attempts are never cached.
   */
  async run(
    key: string,
    fingerprint: string,
    generate: () => Promise<LinkMetadataResponseDto>,
  ): Promise<LinkMetadataIdempotencyRun> {
    const active = this.inFlight.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) {
        return { status: 'conflict' };
      }
      return { status: 'ok', response: await active.promise };
    }

    const replay = this.lookup(key, fingerprint);
    if (replay.status === 'conflict') {
      return { status: 'conflict' };
    }
    if (replay.status === 'hit') {
      return { status: 'ok', response: replay.response };
    }

    const promise = (async () => {
      const response = await generate();
      this.remember(key, fingerprint, response);
      return response;
    })();

    this.inFlight.set(key, { fingerprint, promise });
    try {
      return { status: 'ok', response: await promise };
    } finally {
      this.inFlight.delete(key);
    }
  }

  remember(
    key: string,
    fingerprint: string,
    response: LinkMetadataResponseDto,
  ): void {
    const now = Date.now();
    this.prune(now);

    // Delete before re-inserting so the most recent use is evicted last.
    this.entries.delete(key);
    this.entries.set(key, {
      fingerprint,
      response,
      expiresAt: now + LINK_METADATA_IDEMPOTENCY_TTL_MS,
    });

    while (this.entries.size > LINK_METADATA_IDEMPOTENCY_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
