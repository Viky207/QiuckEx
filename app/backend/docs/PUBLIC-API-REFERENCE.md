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

## Escrow expiry

Escrow links carry an `expires_at` ledger timestamp. Expiry is evaluated against the
current ledger close time using a strict comparison, so the boundary is deterministic:

| Current ledger time vs `expires_at` | Escrow state |
| --- | --- |
| `now < expires_at` (immediately before) | `active` — funds can still be released or refunded |
| `now == expires_at` (exactly at) | `active` — the escrow is **not** expired at the exact boundary |
| `now > expires_at` (immediately after) | `expired` — only refund is permitted |

In other words, an escrow expires only once the ledger time is strictly greater than
`expires_at`. At the exact equality point the escrow remains active, matching the
documented state-transition table.

---

## Escrow terminal transitions

An escrow has exactly two terminal transitions: **release** and **refund**. Once an
escrow reaches a terminal state (`released` or `refunded`) it can never transition
again. This makes retries safe: a client that times out and retries a release or
refund will never move funds twice.

### Idempotency guarantees

- The **first** terminal call on an `active` escrow succeeds and moves funds exactly
  once. The escrow state becomes `released` or `refunded` accordingly.
- **Any subsequent** terminal call — a repeated release, a repeated refund, or a call
  crossing terminal states (release after refund, refund after release) — is rejected
  with a stable error and **no balance change**.
- The rejection error is consistent regardless of which terminal state was reached
  first, so clients can treat it as a permanent (non-retryable) failure.

| Current state | `release` | `refund` |
| --- | --- | --- |
| `active` | succeeds → `released` | succeeds → `refunded` |
| `released` | rejected (stable error) | rejected (stable error) |
| `refunded` | rejected (stable error) | rejected (stable error) |
| `expired` | rejected (stable error) | succeeds → `refunded` |

In every rejected case the escrow balance and the recipient/sender balances are left
unchanged, so duplicate terminal calls are always safe to retry against.
