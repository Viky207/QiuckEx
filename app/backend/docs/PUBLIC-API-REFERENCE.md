# Public API Reference

Base URL: `https://api.quickex.example`

All authenticated endpoints require a bearer token:

```
Authorization: Bearer <access_token>
```

---

## Privacy modes

QuickEx links can be created in one of two privacy modes. The table below states exactly what each mode exposes on-chain and off-chain. No mode hides information that the Stellar network itself records publicly.

| Information | Public mode | Private mode |
| --- | --- | --- |
| Link URL / slug | Public — anyone with the URL can view the link | Public — the URL is still required to open the link |
| Recipient address | Public — visible in the link and on-chain | Public — the destination address is recorded on-chain |
| Sender address | Public — recorded on-chain | Public — recorded on-chain |
| Amount & asset | Public — recorded on-chain | Public — recorded on-chain |
| Transaction hash | Public — recorded on-chain | Public — recorded on-chain |
| Link metadata (memo, label) | Public — returned by the API | Private — omitted from public API responses |
| Link listing / discovery | Public — appears in public listings | Private — excluded from public listings |

Notes:

- **Private mode does not make on-chain data confidential.** Stellar transactions are public by design; amounts, addresses, and transaction hashes are always visible on the ledger.
- Private mode only limits off-chain exposure: link metadata is not returned by public API responses and the link is excluded from public listings.
- Privacy modes are subject to network availability. If a mode is unavailable on the current network, it cannot be selected when creating a link; the API rejects such requests with `422 Unprocessable Entity`.
- See the [privacy policy](https://quickex.example/privacy) for how QuickEx handles personal data.

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

When the webhook feature is paused, this endpoint responds with `503 Service Unavailable` and no webhook is created.

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

This read remains available while paused.

### Delete a webhook

`DELETE /webhooks/:id`

Response `204 No Content`.

When the webhook feature is paused, this endpoint responds with `503 Service Unavailable` and the webhook is left untouched.

---

## Payment status

`GET /payments/:transaction_hash/status`

Returns the authoritative status for a single payment, keyed by its Stellar transaction hash. Repeated reads for the same hash are **monotonic**: once a payment reaches a terminal state it never regresses to `pending`.

### Status transitions

```
pending ──► confirmed   (terminal)
pending ──► failed      (terminal)
```

- `pending` — the transaction has been submitted but not yet confirmed on-chain.
- `confirmed` — the transaction was observed on Horizon and settled. Terminal.
- `failed` — the transaction was rejected or definitively not settled. Terminal.

Terminal states (`confirmed`, `failed`) are sticky. A later read will never return `pending` for a hash that has already reached a terminal state.

### Transient upstream failures

If Horizon is temporarily unreachable or returns an error while a payment is still `pending`, the endpoint does **not** fabricate settlement. It returns the last known authoritative state (or an error), never a false `confirmed`/`failed`:

- If a terminal state is already known, that terminal state is returned.
- If the payment is still `pending` and Horizon cannot be reached, the response is `503 Service Unavailable` with a retryable error body. Clients should retry with backoff.

Response `200 OK`:

```json
{
  "transaction_hash": "abc123...",
  "status": "confirmed",
  "updated_at": "2024-01-01T00:00:00.000Z"
}
```

Response `503 Service Unavailable` (transient upstream failure, payment still pending):

```json
{
  "error": "upstream_unavailable",
  "message": "Payment status could not be confirmed; retry with backoff.",
  "retryable": true
}
```

---

## Reconciliation

Reconciliation runs over a ledger interval. To keep each run within request time and memory limits, a run processes a **bounded ledger range** per job and persists a resumable cursor with the run metadata.

### Bounded range & cursor

- Each job processes at most `limit` ledgers per invocation. `limit` is configurable but clamped to a safe range (`min`–`max`); out-of-range values are rejected or clamped to the nearest bound.
- The run metadata records a `cursor` (the last fully processed ledger sequence). A restart resumes from `cursor + 1`, so no ledger is skipped or double-counted.
- Progress is observable via the run metadata: `cursor`, `limit`, `processed`, and `complete`.

Response `200 OK` (run metadata):

```json
{
  "run_id": "rec_01HXYZ...",
  "from_ledger": 1000,
  "to_ledger": 5000,
  "cursor": 1499,
  "limit": 500,
  "processed": 500,
  "complete": false
}
```

When `complete` is `true`, `cursor` equals `to_ledger` and the run is finished. Restarting an incomplete run resumes from `cursor + 1`.

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
- While the webhook feature is paused, new deliveries are suspended and resume after unpause; retry/backoff and logging semantics are unchanged.

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

## Contract upgrades

Upgrade authorization is **single-use and artifact-bound**. An approval is only valid for the exact WASM hash and version it was issued for, and only within its approval window.

### Request an upgrade approval

`POST /admin/upgrades/authorize`

Request body:

```json
{
  "wasm_hash": "<hex-encoded sha256 of the approved wasm>",
  "version": "1.4.0",
  "expires_at": "2024-01-01T01:00:00.000Z"
}
```

- `wasm_hash` (required) — the exact artifact hash the approval is bound to.
- `version` (required) — the target contract version the approval is bound to.
- `expires_at` (required) — end of the approval window; the approval is rejected at or after this time.

Response `201 Created`:

```json
{
  "id": "up_01HXYZ...",
  "wasm_hash": "<hex-encoded sha256 of the approved wasm>",
  "version": "1.4.0",
  "expires_at": "2024-01-01T01:00:00.000Z",
  "status": "pending"
}
```

### Apply an upgrade

`POST /admin/upgrades/:id/apply`

Request body:

```json
{
  "wasm_hash": "<hex-encoded sha256 of the approved wasm>",
  "version": "1.4.0"
}
```

The supplied `wasm_hash` and `version` must match the values the approval was issued for. The approval is consumed on success and cannot be reused.

Failure responses (no code or registry state is changed):

| Status | Condition |
| --- | --- |
| `409 Conflict` | Approval already consumed (replay attempt). |
| `410 Gone` | Approval window has expired. |
| `422 Unprocessable Entity` | `wasm_hash` or `version` does not match the approved artifact. |
| `409 Conflict` | Approval was cancelled. |

### Cancel an upgrade approval

`POST /admin/upgrades/:id/cancel`

Response `204 No Content`. A cancelled approval can no longer be applied.
