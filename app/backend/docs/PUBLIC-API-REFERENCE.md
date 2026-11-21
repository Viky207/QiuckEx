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

## Escrows

An escrow locks funds from a creator account until they are released to a recipient or refunded back to the creator.

### Self-directed escrows

QuickEx **allows** the creator and recipient of an escrow to be the same account. This is an explicit, supported configuration:

- **Create** — a self-directed escrow is created like any other; the creator's balance is debited by the escrowed amount.
- **Release** — releasing a self-directed escrow credits the recipient (the same account), so the net balance change is zero and total balances are conserved.
- **Refund** — refunding a self-directed escrow returns the funds to the creator (the same account), again a net-zero balance change.

Role checks are still enforced: only the creator may refund and only the designated recipient may release, even when both roles resolve to the same account. No path bypasses these checks, and balances always conserve across create, release, and refund.

### Batch and cleanup limits

Contract-side batch and cleanup entry points iterate over caller-supplied collections. To keep ledger execution and memory within budget, each entry point enforces a maximum batch size:

| Entry point | Maximum items per call |
| --- | --- |
| Batch escrow creation | `MAX_BATCH_SIZE` (see contract constants) |
| Batch escrow release | `MAX_BATCH_SIZE` |
| Batch escrow refund | `MAX_BATCH_SIZE` |
| Cleanup of expired escrows | `MAX_CLEANUP_BATCH` |

- **Fail before mutation** — if the supplied collection exceeds the maximum, the call fails with a `BatchTooLarge` error and **no state is mutated**. Validation runs before any balance movement or storage write.
- **Bounded work** — work scales only with the bounded input; a call at the maximum size completes within the ledger budget.
- **Partial cleanup semantics** — cleanup processes at most `MAX_CLEANUP_BATCH` expired escrows per call. If more remain, the call succeeds and the remainder is left for a subsequent call; cleanup is idempotent and safe to re-invoke until no expired escrows remain.
