# Payment review fee and reserve disclosure

The payment review states (`app/frontend/src/components/payment-states/`) show a
`Simulation costs` block between the signing summary and the wallet/signing
action. It is intentionally a **read-only projection of simulation data**: the
client never computes a network fee or an account reserve from unrelated values.

## What is displayed

| Row | Source | When the API omits it |
|---|---|---|
| **Network fee** | `PaymentSimulation.feeEstimate.totalFeeXLM` and/or `totalFee` from the simulation payload | `Not provided by simulation` |
| **Account reserve** | `PaymentSimulation.accountReserve` / `reserveRequirement` (`xlm` or `stroops`), or `minReserveXlm` / `minReserve` | `Not provided by simulation` |

Values are shown in the unit the API returned; when both stroops and XLM are
returned, both are shown. A zero value is a real value and is displayed as such.
The existing swap-route estimate is labelled `Estimated Path Cost (route)` and
is deliberately **not** used as the network fee.

The source line reads `Source: Transaction simulation` unless the payload sets
`source`, and includes `observedAt` when supplied. No XDR, signature, key, or
wallet/account identifier is rendered by this component.

## Stale simulation handling

When the user presses **Review Payment**, the review records an opaque identity
for the simulation:

1. `simulationId` or `idempotencyKey` when the API provides one, combined with
2. a fingerprint of the disclosed values and `observedAt`. `unsignedXdr` is only
   hashed for this fingerprint and is never shown or logged.

Combining both means a refreshed payload is detected even if the API reuses an
operation id.

If the simulation payload changes while the review is open, the fee and reserve
rows change to `Stale — refresh review`, an alert explains that the simulation
changed, and the **Open Wallet & Pay** action is disabled. **Refresh review**
re-snapshots the current simulation and re-enables signing. An absent simulation
is not treated as a changed one until a review has been recorded.

## Scope and status

The payment signing state is still mocked end-to-end (see
[CAPABILITY-MAP.md](./CAPABILITY-MAP.md), contributor note 3): the disclosure is
**Partial** until the payment page supplies simulation data from a real payment
simulation. The optional `simulation` field on the payment status payload is an
additive contract; no existing required field changes. Callers that do not supply
it see an explicit "not provided" state instead of a guessed value.
