import { describe, expect, it } from "vitest";
import {
  getSimulationIdentity,
  isFeeReserveReviewStale,
  readFeeReserveDisclosure,
  type PaymentSimulation,
} from "@/lib/payment/simulationDisclosure";

describe("payment simulation cost disclosure", () => {
  it("keeps simulation fee and reserve separate and preserves API units", () => {
    const simulation: PaymentSimulation = {
      idempotencyKey: "sim-1",
      feeEstimate: { totalFee: "350", totalFeeXLM: "0.0000350" },
      accountReserve: { stroops: "5000000", xlm: "0.5000000" },
    };

    const disclosure = readFeeReserveDisclosure(simulation);

    expect(disclosure.fee).toEqual({
      available: true,
      text: "0.0000350 XLM (350 stroops)",
    });
    expect(disclosure.reserve).toEqual({
      available: true,
      text: "0.5000000 XLM (5000000 stroops)",
    });
    expect(disclosure.source).toBe("Transaction simulation");
    expect(disclosure.identity).toMatch(/^sim-1:/);
  });

  it("never fabricates a missing reserve or fee", () => {
    const disclosure = readFeeReserveDisclosure({
      feeEstimate: { totalFeeXLM: "0.0000350" },
    });

    expect(disclosure.fee.text).toBe("0.0000350 XLM");
    expect(disclosure.reserve).toEqual({
      available: false,
      text: "Not provided by simulation",
    });

    const empty = readFeeReserveDisclosure(null);
    expect(empty.fee.available).toBe(false);
    expect(empty.reserve.available).toBe(false);
    expect(empty.fee.text).toBe(empty.reserve.text);
    expect(empty.identity).toBeNull();
  });

  it("treats a zero stroops value as provided, not missing", () => {
    const disclosure = readFeeReserveDisclosure({
      feeEstimate: { totalFee: 0 },
      minReserve: "0",
    });

    expect(disclosure.fee).toEqual({ available: true, text: "0 stroops" });
    expect(disclosure.reserve).toEqual({ available: true, text: "0 stroops" });
  });

  it("uses the API-provided source label when present", () => {
    expect(readFeeReserveDisclosure({ source: "Soroban RPC simulation" }).source).toBe(
      "Soroban RPC simulation",
    );
  });

  it("detects a changed simulation and requires a refreshed review", () => {
    const original: PaymentSimulation = {
      idempotencyKey: "sim-1",
      feeEstimate: { totalFee: "350" },
    };
    const changed: PaymentSimulation = {
      idempotencyKey: "sim-2",
      feeEstimate: { totalFee: "500" },
    };
    const reviewedIdentity = getSimulationIdentity(original);

    expect(isFeeReserveReviewStale(original, reviewedIdentity)).toBe(false);
    expect(isFeeReserveReviewStale(changed, reviewedIdentity)).toBe(true);
    expect(isFeeReserveReviewStale(null, reviewedIdentity)).toBe(true);
    expect(isFeeReserveReviewStale(changed, null)).toBe(false);

    const sameIdNewValues: PaymentSimulation = {
      idempotencyKey: "sim-1",
      feeEstimate: { totalFee: "999" },
    };
    expect(isFeeReserveReviewStale(sameIdNewValues, reviewedIdentity)).toBe(true);
  });

  it("fingerprints value changes when the API omits an identity", () => {
    const original: PaymentSimulation = {
      feeEstimate: { totalFee: "350" },
      accountReserve: { xlm: "0.5000000" },
    };
    const same = structuredClone(original);
    const changed: PaymentSimulation = {
      ...original,
      accountReserve: { xlm: "1.0000000" },
    };
    const reviewedIdentity = getSimulationIdentity(original);

    expect(reviewedIdentity).toMatch(/^fingerprint:/);
    expect(getSimulationIdentity(same)).toBe(reviewedIdentity);
    expect(isFeeReserveReviewStale(same, reviewedIdentity)).toBe(false);
    expect(isFeeReserveReviewStale(changed, reviewedIdentity)).toBe(true);
  });

  it("never exposes unsigned XDR in the review identity", () => {
    const simulation: PaymentSimulation = {
      unsignedXdr: "AAAAA-secret-looking-transaction-payload",
      feeEstimate: { totalFee: "350" },
    };
    const identity = getSimulationIdentity(simulation);

    expect(identity).not.toContain("AAAAA");
    expect(identity).not.toContain("secret-looking");
  });
});
