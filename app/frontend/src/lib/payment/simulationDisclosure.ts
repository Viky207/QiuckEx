/**
 * Presentation contract for simulation-backed fee and reserve disclosure.
 *
 * The payment review must only show values that the simulation API actually
 * returned. Nothing in this module derives a network fee or an account reserve
 * from unrelated data (for example, a swap route or a hardcoded base reserve).
 */

export interface SimulationFeeEstimate {
  totalFee?: string | number | null;
  totalFeeXLM?: string | number | null;
  baseFee?: string | number | null;
  inclusionFee?: string | number | null;
}

export interface SimulationReserve {
  stroops?: string | number | null;
  xlm?: string | number | null;
}

/**
 * Optional simulation payload consumed by the payment review. All fields are
 * optional because the API may omit them; absent fields are reported as such
 * rather than estimated.
 */
export interface PaymentSimulation {
  /** Stable identity supplied by the API, when available. */
  simulationId?: string | null;
  /** Compose/simulate responses use this as their stable operation identity. */
  idempotencyKey?: string | null;
  /**
   * Unsigned XDR is accepted only to fingerprint a simulation. It is never
   * rendered, logged, or returned as review text.
   */
  unsignedXdr?: string | null;
  observedAt?: string | null;
  source?: string | null;
  feeEstimate?: SimulationFeeEstimate | null;
  accountReserve?: SimulationReserve | null;
  reserveRequirement?: SimulationReserve | null;
  minReserve?: string | number | null;
  minReserveXlm?: string | number | null;
}

export interface DisclosureValue {
  /** Whether a value was actually supplied by the simulation API. */
  available: boolean;
  /** Text safe to render; never contains XDR or signing material. */
  text: string;
}

export interface FeeReserveDisclosure {
  fee: DisclosureValue;
  reserve: DisclosureValue;
  source: string;
  observedAt: string | null;
  /** Opaque identity of the reviewed simulation (never raw XDR). */
  identity: string | null;
}

const NOT_PROVIDED = "Not provided by simulation";
const DEFAULT_SOURCE = "Transaction simulation";

function present(value: unknown): value is string | number {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  return false;
}

function text(value: unknown): string | null {
  return present(value) ? String(value).trim() : null;
}

function withUnit(value: string, unit: string): string {
  return `${value} ${unit}`;
}

function formatValue(xlm: unknown, stroops: unknown, stroopLabel = "stroops"): DisclosureValue {
  const xlmText = text(xlm);
  const stroopsText = text(stroops);

  if (!xlmText && !stroopsText) {
    return { available: false, text: NOT_PROVIDED };
  }

  if (xlmText && stroopsText) {
    return {
      available: true,
      text: `${withUnit(xlmText, "XLM")} (${withUnit(stroopsText, stroopLabel)})`,
    };
  }

  return {
    available: true,
    text: xlmText ? withUnit(xlmText, "XLM") : withUnit(stroopsText!, stroopLabel),
  };
}

/** Small deterministic, non-cryptographic fingerprint for change detection. */
function fingerprint(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Returns an opaque, stable identity for the supplied simulation. The explicit
 * id (when provided) is combined with a fingerprint of the disclosed values so
 * that a refreshed payload is detected even if the API reuses the id. Unsigned
 * XDR is hashed and never exposed as review text.
 */
export function getSimulationIdentity(simulation?: PaymentSimulation | null): string | null {
  if (!simulation) return null;

  const explicitId = text(simulation.simulationId) ?? text(simulation.idempotencyKey);

  const canonical = {
    feeTotalFee: text(simulation.feeEstimate?.totalFee),
    feeTotalFeeXLM: text(simulation.feeEstimate?.totalFeeXLM),
    reserveStroops: text(simulation.accountReserve?.stroops ?? simulation.reserveRequirement?.stroops),
    reserveXlm: text(
      simulation.accountReserve?.xlm ??
        simulation.reserveRequirement?.xlm ??
        simulation.minReserveXlm,
    ),
    minReserve: text(simulation.minReserve),
    observedAt: text(simulation.observedAt),
    unsignedXdrFingerprint: text(simulation.unsignedXdr)
      ? fingerprint(text(simulation.unsignedXdr)!)
      : null,
  };

  const valueFingerprint = fingerprint(JSON.stringify(canonical));
  return explicitId ? `${explicitId}:${valueFingerprint}` : `fingerprint:${valueFingerprint}`;
}

/** True when the current simulation no longer matches the reviewed one. */
export function isFeeReserveReviewStale(
  simulation?: PaymentSimulation | null,
  reviewedIdentity?: string | null,
): boolean {
  if (reviewedIdentity == null) return false;
  return getSimulationIdentity(simulation) !== reviewedIdentity;
}

/** Projects a simulation payload into review-only, labelled values. */
export function readFeeReserveDisclosure(
  simulation?: PaymentSimulation | null,
): FeeReserveDisclosure {
  const reserve = simulation?.accountReserve ?? simulation?.reserveRequirement ?? null;

  return {
    fee: formatValue(simulation?.feeEstimate?.totalFeeXLM, simulation?.feeEstimate?.totalFee),
    reserve: formatValue(
      reserve?.xlm ?? simulation?.minReserveXlm,
      reserve?.stroops ?? simulation?.minReserve,
    ),
    source: text(simulation?.source) ?? DEFAULT_SOURCE,
    observedAt: text(simulation?.observedAt),
    identity: getSimulationIdentity(simulation),
  };
}
