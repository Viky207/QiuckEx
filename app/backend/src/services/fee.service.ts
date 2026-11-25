/**
 * Fee calculation service.
 *
 * Fees are expressed in basis points (1 bps = 0.01%). All arithmetic is done
 * with integers so results are deterministic across platforms.
 *
 * Rounding direction: fees are rounded DOWN (floor) to the smallest supported
 * asset unit. This guarantees that `fee + recipientAmount === depositAmount`
 * for every deposit, and that a fee can never exceed the configured ceiling.
 * At the smallest supported amounts a fee may round to zero, which is the
 * intended behavior (the recipient receives the full deposit).
 */

export const BPS_DENOMINATOR = 10_000;

export interface FeeConfig {
  /** Fee in basis points. */
  feeBps: number;
  /** Absolute maximum fee in the smallest asset unit. */
  maxFee: number;
}

export interface FeeBreakdown {
  /** Fee charged, in the smallest asset unit. */
  fee: number;
  /** Amount delivered to the recipient, in the smallest asset unit. */
  recipientAmount: number;
}

/**
 * Compute the fee for a deposit using integer, floor-rounded basis points.
 *
 * The fee is clamped to `[0, maxFee]` and can never exceed the deposit, so
 * `fee + recipientAmount` always conserves the deposit.
 */
export function calculateFee(depositAmount: number, config: FeeConfig): FeeBreakdown {
  if (!Number.isInteger(depositAmount) || depositAmount < 0) {
    throw new RangeError('depositAmount must be a non-negative integer');
  }
  if (!Number.isInteger(config.feeBps) || config.feeBps < 0) {
    throw new RangeError('feeBps must be a non-negative integer');
  }
  if (!Number.isInteger(config.maxFee) || config.maxFee < 0) {
    throw new RangeError('maxFee must be a non-negative integer');
  }

  // Integer floor division: (deposit * bps) / 10_000, rounded down.
  const rawFee = Math.floor((depositAmount * config.feeBps) / BPS_DENOMINATOR);

  // Clamp to the configured ceiling and never exceed the deposit itself.
  const fee = Math.min(rawFee, config.maxFee, depositAmount);

  return {
    fee,
    recipientAmount: depositAmount - fee,
  };
}
