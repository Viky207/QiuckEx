# Public API Reference

Base URL: `https://api.quickex.example`

All authenticated endpoints require a bearer token:

```
Authorization: Bearer <access_token>
```

---

## Webhooks

Register a webhook URL to receive a `POST` request whenever a payment to one of your QuickEx links is confirmed on the Stellar network.

### Register a webhook

`POST /webhooks`

Request body:

```json
{
  "url": "https://example.com/hooks/quickex",
  "secret": "optional-shared-secret"
}
```

- `url` (required) — HTTPS endpoint that will receive deliveries.
- `secret` (optional) — when provided, deliveries are signed with HMAC-SHA256 (see below).

Response `201 Created`:

```json
{
  "id": "wh_01HXYZ...",
  "url": "https://example.com/hooks/quickex",
  "is_active": true,
  "created_at": "2024-01-01T00:00:00.000Z"
}
```

### List webhooks

`GET /webhooks`

Returns the webhooks registered for the authenticated user. URLs are masked after the first 20 characters.

Response `200 OK`:

```json
[
  {
    "id": "wh_01HXYZ...",
    "url": "https://example.com/h...",
    "is_active": true,
    "created_at": "2024-01-01T00:00:00.000Z"
  }
]
```

### Delete a webhook

`DELETE /webhooks/:id`

Response `204 No Content`.

---

## Webhook payload

Deliveries are sent as `POST` requests with `Content-Type: application/json`.

```json
{
  "event": "payment.completed",
  "delivery_id": "wd_01HXYZ...",
  "subscription_id": "wh_01HXYZ...",
  "payment": {
    "id": "pay_01HXYZ...",
    "link_id": "link_01HXYZ...",
    "amount": "25.0000000",
    "asset": "XLM",
    "from": "G...",
    "to": "G...",
    "transaction_hash": "abc123...",
    "confirmed_at": "2024-01-01T00:00:00.000Z"
  },
  "triggered_at": "2024-01-01T00:00:01.000Z"
}
```

### Delivery & retries

- A delivery is considered successful when your endpoint responds with a `2xx` status code.
- Failed deliveries are retried with exponential backoff: up to **5 retries over 24 hours**.
- Each attempt is logged (timestamp, status code, response snippet) and can be inspected via the delivery log.

### Signature verification

When a `secret` was supplied at registration, each request includes an `X-QuickEx-Signature` header containing the hex-encoded HMAC-SHA256 of the raw request body, keyed with your secret.

Always verify the signature against the **raw** request body before trusting the payload.

#### Node.js

```js
const crypto = require('crypto');

function verifyQuickExSignature(rawBody, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature || '', 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Express example (raw body required)
app.post('/hooks/quickex', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.get('X-QuickEx-Signature');
  if (!verifyQuickExSignature(req.body, signature, process.env.QUICKEX_WEBHOOK_SECRET)) {
    return res.status(401).send('invalid signature');
  }
  const event = JSON.parse(req.body.toString('utf8'));
  // handle event...
  res.status(200).send('ok');
});
```

#### Python

```python
import hmac
import hashlib


def verify_quickex_signature(raw_body: bytes, signature: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature or "")


# Flask example
from flask import Flask, request, abort

app = Flask(__name__)


@app.post("/hooks/quickex")
def quickex_hook():
    signature = request.headers.get("X-QuickEx-Signature", "")
    if not verify_quickex_signature(request.get_data(), signature, "your-secret"):
        abort(401)
    event = request.get_json(force=True)
    # handle event...
    return "ok", 200
```

---

## Escrow state invariants

Escrow operations are atomic: a failed invocation must leave all invariant-relevant state unchanged. This applies to both authorization failures (e.g. caller is not the escrow owner or signer) and downstream transfer failures (e.g. the token transfer reverts or the destination rejects the payment).

When an invocation fails, the following are guaranteed to be unchanged from their pre-call values:

- The escrow record (status, amounts, parties, and timestamps).
- The associated storage entries and their versioned keys.
- Account balances for both the source and destination parties.

Clients should treat any non-`2xx` response as a no-op and may safely retry idempotent operations. Failed invocations do not emit `payment.completed` webhooks.

---

## Escrow event ordering

Some escrow operations perform multiple state updates in a single invocation (for example, releasing funds and marking the escrow as settled). Indexers may rely on the order of emitted events to reconstruct the lifecycle, so the following guarantees apply.

### Guarantees

- **Committed state only.** Events are emitted only after the corresponding state change has been committed. An event never describes state that was rolled back.
- **Stable ordering.** When a single invocation emits multiple events, they are emitted in a fixed, documented order (see below). The order does not depend on map iteration, storage layout, or caller input.
- **No partial sequences on failure.** If an invocation fails at any point — authorization, validation, or a downstream transfer — no lifecycle events are emitted for that invocation. Indexers will never observe a prefix of a multi-event sequence without its completion.

### Multi-event operations

For operations that emit more than one event, the emission order is:

1. `escrow.updated` — reflects the escrow record transition (e.g. `funded` → `released`).
2. `payment.completed` — reflects the settled transfer, including the final `amount`, `asset`, `from`, `to`, and `transaction_hash`.

Each event in the sequence carries the same `escrow_id` and `transaction_hash`, so consumers can correlate them. Payload fields are consistent across the sequence: the `amount` and `asset` reported in `payment.completed` match the values recorded in the `escrow.updated` event for the same invocation.

### Failure behavior

If the invocation fails, neither `escrow.updated` nor `payment.completed` is emitted. Consumers should not infer a lifecycle transition from the absence of events; instead, treat the failed response as a no-op (see [Escrow state invariants](#escrow-state-invariants)).
