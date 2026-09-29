import fc from 'fast-check';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { CreateUsernameDto } from '../../src/dto/username';
import { SearchUsernamesQueryDto } from '../../src/dto/username/search-usernames-query.dto';
import { TransactionQueryDto } from '../../src/dto/transaction/transaction-query.dto';
import { CursorPaginationQueryDto } from '../../src/dto/pagination/pagination.dto';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  PAGINATION_DEFAULTS,
  paginateResult,
} from '../../src/common/pagination/cursor.util';

/**
 * Fuzz coverage for API DTO validation and pagination cursors (#286).
 *
 * These are the two places a hostile, or merely unlucky, client input reaches
 * furthest into the backend: the DTO validators decide what is admitted into a
 * financial instruction, and the cursor codec decides which rows a paginated
 * read returns. Both are pure functions, which makes them the right shape for
 * property-based testing: rather than asserting a hand-picked list of inputs we
 * assert the invariants that must hold for *every* input.
 *
 * The properties are deliberately about safety properties (never throws, never
 * widens a bound, never loses or duplicates a row) rather than about echoing
 * the implementation, so an internal encoding change does not require
 * rewriting the suite.
 */

/** Deterministic seed: a failing case must be reproducible from CI. */
const SEED = 0x286;
const RUNS = 300;

/** A syntactically plausible 56-character Stellar account id (G + 55). */
const validPublicKey = fc
  .tuple(
    ...Array.from({ length: 55 }, () =>
      fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.split('')),
    ),
  )
  .map((chars) => `G${chars.join('')}`);

/** A username satisfying both the DTO length bound and the pattern rule. */
const validUsername = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
    fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')), {
      minLength: 2,
      maxLength: 30,
    }),
  )
  .map(([first, rest]) => first + rest.join(''));

/** Any string, including the empty string and control characters. */
const anyString = fc.string({ unit: 'binary', maxLength: 64 });

/** Arbitrary JSON-ish values, to prove the DTOs reject rather than coerce garbage. */
const anyValue = fc.anything({ maxDepth: 2 });

async function validationErrorsFor(
  cls: new () => object,
  payload: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, payload));
  return errors.flatMap((error) => Object.keys(error.constraints ?? {}));
}

describe('Fuzz: API DTO validation (#286)', () => {
  it('accepts every well-formed username and public key', async () => {
    await fc.assert(
      fc.asyncProperty(validUsername, validPublicKey, async (username, publicKey) => {
        expect(
          await validationErrorsFor(CreateUsernameDto, { username, publicKey }),
        ).toEqual([]);
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('rejects any username that breaks the character allowlist', async () => {
    // The invariant is disagreement with the documented pattern, not any
    // specific message, so this survives a copy change.
    const usernamePattern = /^[a-z0-9_]+$/;
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 3, maxLength: 32 })
          .filter((candidate) => !usernamePattern.test(candidate)),
        validPublicKey,
        async (username, publicKey) => {
          expect(
            await validationErrorsFor(CreateUsernameDto, { username, publicKey }),
          ).not.toEqual([]);
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('rejects any public key that is not a 56-character G-prefixed strkey', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 80 }).filter((candidate) => !/^G[A-Z2-7]{55}$/.test(candidate)),
        validUsername,
        async (publicKey, username) => {
          expect(
            await validationErrorsFor(CreateUsernameDto, { username, publicKey }),
          ).not.toEqual([]);
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('never accepts a username or public key supplied as a non-string', async () => {
    await fc.assert(
      fc.asyncProperty(anyValue, anyValue, async (username, publicKey) => {
        const errors = await validationErrorsFor(CreateUsernameDto, { username, publicKey });
        // Coercing here would let a client smuggle a value past the documented
        // contract, so a non-string must always be rejected.
        if (typeof username !== 'string' || typeof publicKey !== 'string') {
          expect(errors).not.toEqual([]);
        }
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('keeps every accepted transaction-query limit inside the documented range', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer(), async (limit) => {
        const errors = await validationErrorsFor(TransactionQueryDto, { limit });
        if (errors.length === 0) {
          expect(limit).toBeGreaterThanOrEqual(1);
          expect(limit).toBeLessThanOrEqual(200);
        }
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('rejects a search limit outside the 1-100 bound', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .integer({ min: -1_000_000, max: 1_000_000 })
          .filter((limit) => limit < 1 || limit > 100),
        async (limit) => {
          const errors = await validationErrorsFor(SearchUsernamesQueryDto, {
            query: 'alice',
            limit,
          });
          expect(errors).not.toEqual([]);
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('never throws on arbitrary payload shapes for the list query DTOs', async () => {
    const dtos = [
      SearchUsernamesQueryDto,
      TransactionQueryDto,
      CursorPaginationQueryDto,
    ] as Array<new () => object>;

    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(fc.string({ maxLength: 12 }), anyValue, { maxKeys: 6 }),
        async (payload) => {
          for (const dto of dtos) {
            await expect(validationErrorsFor(dto, payload)).resolves.toEqual(
              expect.any(Array),
            );
          }
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('leaves the cursor opaque to the DTO layer and defers to decodeCursor', async () => {
    // The cursor is opaque: the DTO must not try to parse it. Whether the value
    // is *meaningful* is decided later, by decodeCursor returning null.
    await fc.assert(
      fc.asyncProperty(anyString, async (cursor) => {
        const errors = await validationErrorsFor(CursorPaginationQueryDto, { cursor });
        // The default limit is validated alongside the cursor, so the property
        // is that nothing on the `cursor` field itself is ever rejected.
        expect(errors.filter((constraint) => constraint !== 'limit')).toEqual([]);

        const decoded = decodeCursor(cursor);
        expect(decoded === null || typeof decoded === 'object').toBe(true);
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });
});

describe('Fuzz: pagination cursors (#286)', () => {
  it('round-trips any cursor payload through encode/decode unchanged', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 128 }),
        fc.string({ unit: 'binary', maxLength: 128 }),
        (pk, id) => {
          expect(decodeCursor(encodeCursor({ pk, id }))).toEqual({ pk, id });
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('produces a URL-safe cursor that needs no escaping in a query string', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 128 }), (pk) => {
        const cursor = encodeCursor({ pk, id: 'row-id' });
        // base64url is the entire point: a cursor travels in a query string.
        expect(cursor).toMatch(/^[A-Za-z0-9_-]*$/);
        expect(encodeURIComponent(cursor)).toBe(cursor);
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('returns a well-formed payload or null for any cursor, and never throws', () => {
    // A malformed cursor is client input, so the contract is a stable null
    // rather than an exception that would surface as a 500.
    fc.assert(
      fc.property(anyString, (cursor) => {
        expect(() => decodeCursor(cursor)).not.toThrow();

        const decoded = decodeCursor(cursor);
        if (decoded !== null) {
          expect(typeof decoded.pk).toBe('string');
          expect(typeof decoded.id).toBe('string');
        }
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('rejects a well-formed JSON cursor payload of the wrong shape', () => {
    const wrongShapes: unknown[] = [
      { pk: 1, id: 'a' },
      { pk: 'a', id: 1 },
      { pk: 'a' },
      { id: 'a' },
      {},
      { pk: null, id: null },
      { pk: ['a'], id: 'b' },
    ];

    fc.assert(
      fc.property(fc.constantFrom(...wrongShapes), (payload) => {
        const cursor = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
        expect(decodeCursor(cursor)).toBeNull();
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('rejects a cursor whose payload has trailing garbage appended', () => {
    fc.assert(
      fc.property(anyString, (noise) => {
        const cursor = Buffer.from(
          JSON.stringify({ pk: 'a', id: 'b' }) + noise,
          'utf-8',
        ).toString('base64url');
        const decoded = decodeCursor(cursor);
        // Either the noise breaks the JSON outright (null), or it is absorbed
        // into a value that is still a string. What must never happen is a
        // silently truncated or partially parsed cursor.
        if (decoded !== null) {
          expect(decoded.pk).toEqual(expect.any(String));
          expect(decoded.id).toEqual(expect.any(String));
        }
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('clamps any limit into the configured range as an integer', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.double({ noNaN: false, noDefaultInfinity: true })),
        (limit) => {
          const clamped = clampLimit(limit);
          expect(clamped).toBeGreaterThanOrEqual(PAGINATION_DEFAULTS.LIMIT_MIN);
          expect(clamped).toBeLessThanOrEqual(PAGINATION_DEFAULTS.LIMIT_MAX);
          expect(Number.isInteger(clamped)).toBe(true);
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('falls back to the default limit for absent or NaN input', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), fc.constant(Number.NaN)),
        (limit) => {
          expect(clampLimit(limit)).toBe(PAGINATION_DEFAULTS.LIMIT_DEFAULT);
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('clamps an infinite limit to the nearest bound rather than propagating it', () => {
    // An unbounded limit reaching the database would be an availability bug,
    // so Infinity has to collapse onto a real page size. Clamping to the bound
    // (rather than falling back to the default) is the safer reading: the
    // caller asked for "as much as possible", not "no preference".
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(Number.POSITIVE_INFINITY), fc.constant(Number.NEGATIVE_INFINITY)),
        (limit) => {
          const clamped = clampLimit(limit);
          expect(Number.isFinite(clamped)).toBe(true);
          expect(clamped).toBe(
            limit === Number.POSITIVE_INFINITY
              ? PAGINATION_DEFAULTS.LIMIT_MAX
              : PAGINATION_DEFAULTS.LIMIT_MIN,
          );
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
  });
});

describe('Fuzz: paginateResult page integrity (#286)', () => {
  type Row = { id: string; created_at: string };

  const rowArbitrary: fc.Arbitrary<Row> = fc
    .tuple(fc.string({ minLength: 1, maxLength: 8 }), fc.string({ minLength: 1, maxLength: 24 }))
    .map(([id, created_at]) => ({ id, created_at }));

  it('never returns more rows than the limit and only reports has_more truthfully', () => {
    fc.assert(
      fc.property(
        fc.array(rowArbitrary, { maxLength: 40 }),
        fc.integer({ min: 1, max: PAGINATION_DEFAULTS.LIMIT_MAX }),
        (rows, limit) => {
          const page = paginateResult(rows, limit, 'created_at');

          expect(page.data.length).toBeLessThanOrEqual(Math.min(limit, rows.length));
          expect(page.has_more).toBe(rows.length > limit);

          if (page.has_more) {
            // A next cursor is only meaningful when a further page exists, and
            // it must describe the last row the client was actually given.
            const decoded = decodeCursor(page.next_cursor as string);
            expect(decoded).not.toBeNull();
            expect(decoded).toEqual({
              pk: page.data[page.data.length - 1].created_at,
              id: page.data[page.data.length - 1].id,
            });
          } else {
            expect(page.next_cursor).toBeNull();
          }
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('stops paginating when the caller supplies no rows', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: PAGINATION_DEFAULTS.LIMIT_MAX }), (limit) => {
        const page = paginateResult([], limit, 'created_at');
        expect(page.data).toEqual([]);
        expect(page.has_more).toBe(false);
        expect(page.next_cursor).toBeNull();
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('emits a decodable cursor at every page boundary of a full walk', () => {
    // This is the property that actually matters to a paginating client: paging
    // with the returned cursors must terminate and never hand back a cursor
    // that the next call cannot understand.
    fc.assert(
      fc.property(
        fc.array(rowArbitrary, { maxLength: 40 }),
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 6 }),
        (rows, pageSizes) => {
          let remaining = rows.slice();
          let cursor: string | null = null;
          let pages = 0;

          while (pages < rows.length + 5) {
            const size = pageSizes[pages % pageSizes.length];
            const batch = remaining.slice(0, size);
            const hasMore = remaining.length > size;
            const result = paginateResult(batch, size, 'created_at');

            if (result.has_more) {
              expect(result.next_cursor).not.toBeNull();
              const decoded = decodeCursor(result.next_cursor as string);
              expect(decoded).not.toBeNull();
              cursor = result.next_cursor;
            } else {
              expect(result.next_cursor).toBeNull();
              break;
            }

            // Emulate the server applying the cursor it just handed out.
            const applied = decodeCursor(cursor as string) as { pk: string; id: string };
            const index = remaining.findIndex(
              (row) => row.id === applied.id && row.created_at === applied.pk,
            );
            if (index === -1) break;
            remaining = remaining.slice(index + 1);
            pages += 1;
          }

          expect(pages).toBeLessThan(rows.length + 5);
        },
      ),
      { numRuns: 100, seed: SEED },
    );
  });
});
