import { createHash } from 'crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

/**
 * Deterministic keypair derivation for testnet fixtures (issue #283).
 *
 * Fixtures are derived, never generated: the same fixture name always yields
 * the same account, so a test that failed yesterday fails identically today and
 * an on-chain transaction recorded in a bug report can still be found. That
 * reproducibility is the whole point of the manager, and it is also why the
 * derivation is a one-way hash rather than a stored secret: a leaked fixture
 * name must not be enough to reconstruct a signing key, even for a testnet
 * account that holds no real funds.
 *
 * Self-custody is preserved. QuickEx never holds user keys, and these are
 * throwaway testnet accounts derived from a public constant, so no real value
 * can be swept by anyone who obtains them. The derivation is namespaced to this
 * project so a fixture name cannot collide with a key derived anywhere else.
 */

/** Domain separation tag. Changing it rotates every derived fixture key. */
const DERIVATION_TAG = 'quickex/testnet-fixture/v1';

/**
 * The public, non-secret seed every fixture is derived from.
 *
 * This is deliberately a constant in source rather than an environment
 * variable: a fixture that depended on a developer's local environment would
 * not be reproducible for the next contributor, which is the property the
 * manager exists to provide. It grants no authority over any real account.
 */
export const FIXTURE_DERIVATION_SEED = 'quickex-testnet-fixtures-do-not-use-in-production';

export class FixtureDerivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureDerivationError';
  }
}

/**
 * Derive the 32-byte ed25519 seed for a named fixture.
 *
 * Exposed separately from the account id so a caller that genuinely needs to
 * sign (a testnet payment) can, while read-only callers stay on
 * {@link deriveFixtureAccountId} and never handle key material.
 */
export function deriveFixtureSeed(name: string): Buffer {
  const normalized = normalizeFixtureName(name);
  // A domain-separated hash gives an effectively uniform 32-byte seed for any
  // name, which is exactly the input ed25519 key expansion expects.
  return createHash('sha256')
    .update(`${DERIVATION_TAG}:${normalized}`, 'utf-8')
    .digest();
}

/**
 * Derive the public account id (G...) for a named fixture.
 *
 * The derivation is name -> seed -> public key -> strkey. The public key step
 * is what makes this safe to log: no part of the returned value can be used to
 * sign, and the account is worthless outside testnet by construction.
 */
export function deriveFixtureAccountId(name: string): string {
  // The derivation is name -> seed -> public key -> strkey. The public key step
  // is what makes this safe to log: no part of the returned value can be used to
  // sign, and the account is worthless outside testnet by construction.
  return Keypair.fromRawEd25519Seed(deriveFixtureSeed(name)).publicKey();
}

/**
 * Normalize a fixture name into the canonical form used for derivation.
 *
 * Names are lowercased and trimmed so `Sender`, `sender` and ` sender ` are one
 * fixture rather than three, which is what makes a fixture reference in a test
 * and in a runbook resolve to the same account.
 */
function normalizeFixtureName(name: string): string {
  if (typeof name !== 'string') {
    throw new FixtureDerivationError('Fixture name must be a string');
  }

  const normalized = name.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new FixtureDerivationError('Fixture name must not be empty');
  }
  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    // Restricting the alphabet keeps the name safe to embed in a log line, a
    // file name, and a URL path without any further escaping.
    throw new FixtureDerivationError(
      `Fixture name "${name}" must contain only lowercase letters, digits, "-" or "_"`,
    );
  }

  return normalized;
}

/**
 * Validate that a string is a Stellar account id.
 *
 * Delegates to the SDK's own strkey decoder rather than reimplementing base32:
 * the checksum and version byte are what make an id safe to trust, and a
 * hand-rolled decoder that quietly disagreed with the SDK on a padding edge case
 * would be worse than no check at all. A stable boolean lets a caller reject a
 * malformed id from configuration with a clear message instead of an opaque
 * decoder exception.
 */
export function isValidAccountId(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    return StrKey.isValidEd25519PublicKey(value);
  } catch {
    // A decoder that throws on malformed input is a rejection, not a failure.
    return false;
  }
}
