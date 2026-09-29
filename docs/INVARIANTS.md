Core Financial Invariants
INV-01: Conservation of Value

The sum of all balances (escrow + merchant + customer + fees) MUST equalthe total value deposited into the system. No value is created or destroyedoutside of explicit protocol actions.
INV-02: No Unauthorized Withdrawals

Only the designated recipient (merchant on fulfill, customer on refund,arbiter on dispute resolution) may claim payment funds. No third partycan withdraw funds from an escrow they are not a party to.
INV-03: No Overpayment

The total amount released from a payment MUST NOT exceed the originaldeposited amount plus any permitted fee adjustments. Each payment releasesat most its principal.
INV-04: No Double-Settlement

A payment can transition to a terminal state (Fulfilled, Refunded,DisputeResolved) exactly once. No payment can be fulfilled AND refunded,or settled twice.
State Machine Invariants
INV-05: Valid State Transitions Only

The payment state machine only permits:  Created → Funded → Fulfilled  Created → Funded → Disputed → DisputeResolved  Created → Funded → Refunded (after expiry)  Created → Expired (if never funded)

No backward or cross-branch transitions are valid.
INV-06: Expiry Monotonicity

A payment whose expiry timestamp has passed cannot be fulfilled. It canonly be refunded or disputed (if already in dispute).
INV-07: Nonce Uniqueness

No two payments can share the same (creator, nonce) pair. Replay of apreviously consumed nonce MUST be rejected.
INV-08: Authorization Consistency

The actor performing a transition MUST be authorized:

    Only creator can fund
    Only merchant can fulfill
    Only customer can request refund
    Only designated arbiter can resolve dispute

Edge-Case Invariants
INV-09: Zero-Amount Payment

Zero-amount payments follow the same state machine but MUST NOT resultin any token transfers.
INV-10: Fee Ceiling

Protocol fees collected per payment MUST NOT exceed the configuredmaximum fee percentage of the payment amount.

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

---

## Architectural Enforcement References

- [CUSTODY-TRUST-THREAT-MODEL.md](./CUSTODY-TRUST-THREAT-MODEL.md): Full threat modeling, trust assumptions, and cryptographic custody boundary enforcement for INV-01 through INV-10.
- [MAINNET-PROMOTION-AND-GOVERNANCE.md](./MAINNET-PROMOTION-AND-GOVERNANCE.md): Invariant verification suite requirements and multisig governance rules prior to Mainnet launch.
- [CAPABILITY-MAP.md](./CAPABILITY-MAP.md): Current implementation status of on-chain and off-chain invariant enforcement.
