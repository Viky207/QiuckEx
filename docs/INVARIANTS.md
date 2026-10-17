Core Financial Invariants
INV-01: Conservation of Value

The sum of all balances (escrow + merchant + customer + fees) MUST equalthe total value deposited into the system. No value is created or destroyedoutside of explicit protocol actions.

- Test file: `tests/invariants/conservation_of_value.test.ts`
- Tests: `conserves total value across fund/fulfill`, `conserves total value across fund/refund`, `conserves total value across disputed settlement`
INV-02: No Unauthorized Withdrawals

Only the designated recipient (merchant on fulfill, customer on refund,arbiter on dispute resolution) may claim payment funds. No third partycan withdraw funds from an escrow they are not a party to.

- Test file: `tests/invariants/authorization.test.ts`
- Tests: `rejects fulfill from non-merchant`, `rejects refund from non-customer`, `rejects dispute resolution from non-arbiter`, `rejects withdrawal by unrelated third party`
INV-03: No Overpayment

The total amount released from a payment MUST NOT exceed the originaldeposited amount plus any permitted fee adjustments. Each payment releasesat most its principal.

- Test file: `tests/invariants/no_overpayment.test.ts`
- Tests: `release never exceeds deposited principal`, `cumulative releases bounded by principal plus permitted fees`
INV-04: No Double-Settlement

A payment can transition to a terminal state (Fulfilled, Refunded,DisputeResolved) exactly once. No payment can be fulfilled AND refunded,or settled twice.

- Test file: `tests/invariants/no_double_settlement.test.ts`
- Tests: `rejects fulfill after refund`, `rejects refund after fulfill`, `rejects second settlement of any terminal state`
State Machine Invariants
INV-05: Valid State Transitions Only

The payment state machine only permits:  Created → Funded → Fulfilled  Created → Funded → Disputed → DisputeResolved  Created → Funded → Refunded (after expiry)  Created → Expired (if never funded)

No backward or cross-branch transitions are valid.

- Test file: `tests/invariants/state_transitions.test.ts`
- Tests: `permits only the documented transition graph`, `rejects backward transitions`, `rejects cross-branch transitions`
INV-06: Expiry Monotonicity

A payment whose expiry timestamp has passed cannot be fulfilled. It canonly be refunded or disputed (if already in dispute).

- Test file: `tests/invariants/expiry_monotonicity.test.ts`
- Tests: `rejects fulfill after expiry`, `permits refund after expiry`, `permits dispute resolution for pre-expiry dispute`
INV-07: Nonce Uniqueness

No two payments can share the same (creator, nonce) pair. Replay of apreviously consumed nonce MUST be rejected.

- Test file: `tests/invariants/nonce_uniqueness.test.ts`
- Tests: `rejects duplicate (creator, nonce) pair`, `rejects replay of consumed nonce`
INV-08: Authorization Consistency

The actor performing a transition MUST be authorized:

    Only creator can fund
    Only merchant can fulfill
    Only customer can request refund
    Only designated arbiter can resolve dispute

- Test file: `tests/invariants/authorization_consistency.test.ts`
- Tests: `only creator can fund`, `only merchant can fulfill`, `only customer can request refund`, `only designated arbiter can resolve dispute`

Edge-Case Invariants
INV-09: Zero-Amount Payment

Zero-amount payments follow the same state machine but MUST NOT resultin any token transfers.

- Test file: `tests/invariants/zero_amount.test.ts`
- Tests: `zero-amount payment follows state machine`, `zero-amount payment performs no token transfers`
INV-10: Fee Ceiling

Protocol fees collected per payment MUST NOT exceed the configuredmaximum fee percentage of the payment amount.

- Test file: `tests/invariants/fee_ceiling.test.ts`
- Tests: `fees never exceed configured maximum percentage`, `fee ceiling enforced across all settlement paths`

---

## Notification & Webhook Invariants

These invariants govern the off-chain notification path. They are as binding as
the financial invariants above: a notification may not move funds, but it may
not leak a secret or deliver a duplicate either. See
[CAPABILITY-MAP.md](./CAPABILITY-MAP.md) for the owning modules.

INV-11: Preference Enforcement

A notification MUST NOT be delivered to a channel the recipient has not
enabled, has not subscribed to for that event type, or has set an amount
threshold the event does not meet. This applies on the first delivery attempt
*and* on every retry: a retry MUST NOT bypass a preference the recipient changed
after the initial failure.

INV-12: Channel Destination Validity

A channel MUST have a usable destination (an address for email, a token for
push, a URL for webhook) before a delivery is attempted. A missing destination
MUST be treated as a suppression with a stable reason, not dispatched into a
provider that can only fail.

INV-13: Suppression Reason Stability

Every suppression MUST report exactly one reason from the fixed set
`CHANNEL_DISABLED`, `EVENT_NOT_SUBSCRIBED`, `BELOW_MIN_AMOUNT`,
`MISSING_DESTINATION`, evaluated in that order. Operators and dashboards MAY
rely on these strings; they are part of the observability contract.

INV-14: Per-Resource Delivery Ordering

Deliveries to a single subscriber endpoint MUST be delivered in enqueue order. A
delivery MUST NOT be attempted while an earlier delivery for the same resource is
still retryable. This guarantee is per endpoint, not per wallet: two endpoints
owned by the same wallet are independent streams and MUST NOT block each other.

INV-15: No Duplicate Delivery

A delivery already recorded as successful MUST NOT be POSTed again. Deduplication
is keyed on (resource, event type, event id, API version), so a redelivery, a
replay, or a repeated scheduler tick is a no-op. A subscriber may additionally
deduplicate on the stable `X-QuickEx-Delivery-ID`.

INV-16: Bounded Retries With Quarantine

A delivery MUST NOT be retried indefinitely. It MUST be quarantined once its
attempt budget is spent, or immediately on a permanent client error, and a
quarantined delivery MUST NOT be retried automatically. Quarantine reasons are
limited to `ATTEMPTS_EXHAUSTED`, `PERMANENT_CLIENT_ERROR`,
`ORDERING_BLOCK_TIMEOUT` and `MANUAL`. Recovery is an explicit operator action.

INV-17: Ordering Must Not Wedge

A quarantined or permanently-failed delivery MUST NOT block later deliveries for
the same resource indefinitely. Ordering is a preference, not a liveness
guarantee: once a predecessor can no longer make progress, the stream is
released.

INV-18: Event Version Pinning

Every webhook delivery MUST carry the subscriber's pinned API version and the
schema version of the specific event. A version upgrade MUST be additive unless
a deprecated version has been announced with a sunset date and migration
guidance. A subscriber's pinned version MUST NOT change as a side effect of an
unrelated update to the webhook.

INV-19: No Secret Leaves the Backend

Credential material (signing secrets, API keys, bearer tokens, mnemonics,
private keys) MUST NOT appear in a webhook payload, in a stored delivery
response body, or in a log line emitted by the notification path, at any nesting
depth. Account identifiers MUST be truncated to a non-reversible prefix in logs
and stored bodies; the full account is the routing key and is not needed for
diagnosis.

INV-20: Rotation Overlap Is Bounded

Rotating a webhook signing secret MUST use the new secret for all subsequent
signatures. The previous secret MAY be retained for verification only, and only
until an explicit expiry. After the expiry the previous secret MUST be rejected.
The previous secret MUST NOT be returned by any API response — only the instant
at which it stops being accepted.

INV-21: Correlation ID Propagation

Every public API response MUST carry a correlation ID header. An inbound
correlation ID MUST be validated against a strict allowlist of characters and
length before it is accepted; an ID that fails validation MUST be rejected or
replaced with a freshly generated one, never echoed back verbatim. The accepted
correlation ID MUST be propagated into all logs, metrics, and outbound calls
made while handling the request, so that a single request can be traced end to
end.

---

## Profile Settings Invariants

These invariants govern the off-chain profile settings path. A profile update
never moves funds, but it may not silently clobber a concurrent edit or lose a
version bump. See [CAPABILITY-MAP.md](./CAPABILITY-MAP.md) for the owning
modules.

INV-21: Profile Version Monotonicity

A profile update MUST only succeed if the client-supplied version matches the
currently stored version. On success the stored version MUST increment
atomically with the write, so that two concurrent updates carrying the same
version cannot both succeed: exactly one wins and the other MUST be rejected as
a conflict. A version MUST NOT decrease, be reused, or be skipped as a side
effect of an unrelated update.

---

## Merchant Payment Preference Invariants

Merchant payment preferences are an off-chain configuration for new payment
links. They do not change contract state, authorize transactions, or transfer
assets.

INV-22: Preferences Do Not Confer Custody or Authorization

A saved accepted-asset list or preferred requested asset MUST NOT authorize a
payment, sign a transaction, initiate a path payment, or move funds. Every
payment continues to require the payer's independent wallet authorization.

INV-23: Settlement Preference Is Accepted and Supported

The preferred requested asset MUST be in the merchant's accepted-asset list.
Every listed asset MUST be in the current supported asset allow-list. Invalid
or unsupported preferences MUST fail before persistence or link generation.

INV-24: Preferences Apply Only to New Links

Changing merchant preferences MUST NOT mutate existing links, submitted
transactions, or any payment's state, authorization, destination, or terminal
settlement. A disabled preference service MUST degrade to the existing explicit
link-generation behavior without changing the payment flow.

---

## Architectural Enforcement References

- [CUSTODY-TRUST-THREAT-MODEL.md](./CUSTODY-TRUST-THREAT-MODEL.md): Full threat modeling, trust assumptions, and cryptographic custody boundary enforcement for INV-01 through INV-10.
- [MAINNET-PROMOTION-AND-GOVERNANCE.md](./MAINNET-PROMOTION-AND-GOVERNANCE.md): Invariant verification suite requirements and multisig governance rules prior to Mainnet launch.
- [CAPABILITY-MAP.md](./CAPABILITY-MAP.md): Current implementation status of on-chain and off-chain invariant enforcement.
