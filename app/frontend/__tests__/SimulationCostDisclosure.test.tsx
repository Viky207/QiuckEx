import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SimulationCostDisclosure } from "@/components/payment-states/SimulationCostDisclosure";
import { getSimulationIdentity } from "@/lib/payment/simulationDisclosure";

describe("SimulationCostDisclosure", () => {
  it("labels fee and reserve separately and names the data source", () => {
    const simulation = {
      idempotencyKey: "sim-1",
      feeEstimate: { totalFee: "350" },
      accountReserve: { xlm: "0.5000000" },
    };
    const html = renderToStaticMarkup(
      <SimulationCostDisclosure
        simulation={simulation}
        reviewedIdentity={getSimulationIdentity(simulation)}
      />,
    );

    expect(html).toContain("Simulation costs");
    expect(html).toContain("Source: Transaction simulation");
    expect(html).toContain("Network fee");
    expect(html).toContain("350 stroops");
    expect(html).toContain("Account reserve");
    expect(html).toContain("0.5000000 XLM");
    expect(html).not.toContain("Refresh review");
  });

  it("reports absent values without inventing them", () => {
    const html = renderToStaticMarkup(<SimulationCostDisclosure simulation={null} />);

    expect(html.match(/Not provided by simulation/g)).toHaveLength(2);
    expect(html).not.toContain("0.5000000 XLM");
  });

  it("withholds stale values and offers a refresh action", () => {
    const original = { idempotencyKey: "sim-1", feeEstimate: { totalFee: "350" } };
    const changed = { idempotencyKey: "sim-2", feeEstimate: { totalFee: "900" } };
    const html = renderToStaticMarkup(
      <SimulationCostDisclosure
        simulation={changed}
        reviewedIdentity={getSimulationIdentity(original)}
        onRefreshReview={() => undefined}
      />,
    );

    expect(html).toContain("The transaction simulation changed after this review");
    expect(html).toContain("Refresh review");
    expect(html).toContain("Stale — refresh review");
    expect(html).not.toContain("900 stroops");
  });
});
