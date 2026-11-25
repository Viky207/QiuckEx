"use client";

import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import {
  isFeeReserveReviewStale,
  readFeeReserveDisclosure,
  type PaymentSimulation,
} from "@/lib/payment/simulationDisclosure";

interface SimulationCostDisclosureProps {
  /** Simulation payload supplied by the API. Absent fields stay unreported. */
  simulation?: PaymentSimulation | null;
  /** Identity of the simulation the user actually reviewed. */
  reviewedIdentity?: string | null;
  onRefreshReview?: () => void;
}

/**
 * Shows only simulation-provided fee and reserve values. If the simulation
 * changes after review, the values are withheld until the review is refreshed.
 */
export function SimulationCostDisclosure({
  simulation,
  reviewedIdentity,
  onRefreshReview,
}: SimulationCostDisclosureProps) {
  const disclosure = readFeeReserveDisclosure(simulation);
  const stale = isFeeReserveReviewStale(simulation, reviewedIdentity);

  return (
    <section
      aria-labelledby="simulation-cost-heading"
      data-testid="simulation-cost-disclosure"
      className="bg-card/60 border border-border rounded-2xl p-5 space-y-4"
    >
      <div>
        <h3 id="simulation-cost-heading" className="text-sm font-bold text-foreground">
          Simulation costs
        </h3>
        <p className="text-[11px] text-subtle mt-1">
          Source: {disclosure.source}
          {disclosure.observedAt ? ` · observed ${disclosure.observedAt}` : ""}
        </p>
      </div>

      <dl className="space-y-2 text-sm">
        <div className="flex justify-between items-center gap-4">
          <dt className="text-muted">Network fee</dt>
          <dd className="font-semibold text-foreground text-right">
            {stale ? "Stale — refresh review" : disclosure.fee.text}
          </dd>
        </div>
        <div className="flex justify-between items-center gap-4">
          <dt className="text-muted">Account reserve</dt>
          <dd className="font-semibold text-foreground text-right">
            {stale ? "Stale — refresh review" : disclosure.reserve.text}
          </dd>
        </div>
      </dl>

      {stale && (
        <div role="alert" className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 space-y-2">
          <p className="flex items-start gap-2 text-xs text-red-400 leading-relaxed">
            <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
            The transaction simulation changed after this review. Costs are hidden until you
            refresh the review. Do not sign the old payload.
          </p>
          <button
            type="button"
            onClick={onRefreshReview}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
          >
            <RefreshCw size={14} />
            Refresh review
          </button>
        </div>
      )}
    </section>
  );
}
