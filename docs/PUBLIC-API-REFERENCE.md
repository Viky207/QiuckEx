# QuickEx Canonical Public API Reference

This document provides the canonical, production-ready specification of all public and authenticated HTTP route definitions exposed by the QuickEx backend API (`app/backend`). It is derived directly from executable controller and route definitions, DTO schemas, and security guards.

---

## 1. Architectural Principles & Invariants

QuickEx is a non-custodial exchange and payment routing protocol built on the Stellar network and Soroban smart contracts. All API endpoints adhere to strict operational and financial invariants:

1. **Self-Custody**: The backend never requests, accepts, or stores private keys. Endpoints that prepare transactions return unsigned XDR payloads (`POST /transactions/compose`, `POST /transactions/build`), requiring client-side wallet signatures (INV-02, INV-08).
2. **Financial Invariants (INV-01 to INV-10)**: Every endpoint handling payments, escrows, and quotes strictly preserves value conservation, single-settlement semantics, and non-reentrant state transitions.
3. **Structured Envelopes & Stable Errors**: All API errors conform to `{ code: string, message: string, fields?: Record<string, string[]> }`.
4. **Degraded-Mode Resilience**: Read endpoints support client-side and edge caching with `ETag` and `If-None-Match` headers. External dependency failures (e.g. Horizon/RPC degradation) fail safely with structured 502/503 errors and never silently alter state.

---

## 2. Global Conventions & Headers

### Base URLs

| Environment | Base URL |
|---|---|
| **Production** | `https://api.quickex.to` |
| **Local Development** | `http://localhost:4000` |
| **Interactive Swagger UI** | `http://localhost:4000/docs` |

> **Note**: The backend mounts routes without a global `/api` prefix. Controller prefixes are the full public routes (e.g., `/username/:username`, `/links/metadata`).

### Authentication & Authorization Schemes

- **Public**: No authentication required. Subject to standard rate limiting (60 requests/minute).
- **API Key (`X-API-Key`)**: Provided via the `X-API-Key: qk_live_...` HTTP header. Raises rate limits to 120+ requests/minute and unlocks developer and partner routes.
- **Admin Scoped (`@RequireScopes('admin')`)**: Requires an API key possessing administrative privileges. Used for deployment registry, contract rollback, and operational management.

### Standard Request Headers

```http
Content-Type: application/json
Accept: application/json
X-API-Key: <optional-api-key>
Idempotency-Key: <optional-uuid-v4>
If-None-Match: <optional-etag>
```

---

## 3. Canonical Route Definitions

### 3.1 Documentation & Specification

#### `GET /docs`
- **Description**: Interactive OpenAPI / Swagger UI interface.
- **Authorization**: Public
- **Response**: `text/html` Swagger UI console.

#### `GET /docs/json` & `GET /docs/openapi.json`
- **Description**: Canonical OpenAPI 3.0 JSON specification generated from executable route decorators and DTO models.
- **Authorization**: Public
- **Headers Returned**: `ETag: "<hash>"`, `Cache-Control: public, max-age=300`
- **Response `200 OK`**: Complete OpenAPI JSON object.
- **Error `503 Service Unavailable`**:
  ```json
  {
    "code": "SPEC_NOT_READY",
    "message": "OpenAPI document has not been generated yet."
  }
  ```

#### `POST /docs/json`
- **Description**: Legacy CI and export endpoint returning the validated specification.
- **Authorization**: Public
- **Response `200 OK`**: Complete OpenAPI JSON object.

---

### 3.2 System Health & Telemetry

#### `GET /health`
- **Description**: Shallow liveness probe for container orchestrators and load balancers.
- **Authorization**: Public
- **Response `200 OK`**:
  ```json
  {
    "status": "ok",
    "timestamp": "2026-09-24T12:00:00.000Z",
    "uptime": 1423.5,
    "network": "testnet"
  }
  ```

#### `GET /ready`
- **Description**: Deep readiness probe verifying Supabase, Redis, and Horizon connectivity.
- **Authorization**: Public
- **Response `200 OK`**:
  ```json
  {
    "status": "ready",
    "checks": {
      "database": "connected",
      "horizon": "connected",
      "redis": "connected"
    }
  }
  ```
- **Error `503 Service Unavailable`**: If any critical upstream dependency is unreachable.

#### `GET /metrics`
- **Description**: Prometheus-formatted telemetry metrics.
- **Authorization**: Public / Scoped internal
- **Response `200 OK`**: `text/plain` OpenMetrics exposition.

---

### 3.3 Usernames & Public Profiles

#### `GET /username/:username`
- **Description**: Resolves a registered QuickEx username to its Stellar public key and public profile metadata.
- **Authorization**: Public
- **Path Parameters**: `username` (string, 3–30 alphanumeric characters)
- **Response `200 OK` (Public Profile)**:
  ```json
  {
    "id": "usr_94b29f",
    "username": "alice",
    "publicKey": "GABCD1234567890STUVWXYZ...",
    "isPublic": true,
    "lastActiveAt": "2026-09-24T10:15:00Z",
    "createdAt": "2026-01-15T08:00:00Z"
  }
  ```
- **Response `200 OK` (Private Profile - Privacy Degraded)**:
  ```json
  {
    "username": "alice",
    "isPublic": false
  }
  ```
- **Error `404 Not Found`**:
  ```json
  {
    "code": "USERNAME_NOT_FOUND",
    "message": "Username alice is not registered."
  }
  ```

#### `GET /username/search?query=...&limit=...`
- **Description**: Search directory for public usernames.
- **Authorization**: Public
- **Response `200 OK`**: Array of public username objects.

#### `POST /username/toggle-public`
- **Description**: Toggles profile visibility between public discovery and private link-only mode.
- **Authorization**: Authenticated (Wallet signature or API Key)
- **Request Body**: `{ "username": "alice", "isPublic": false }`
- **Response `200 OK`**: `{ "success": true, "isPublic": false }`

---

### 3.4 Payment Links

#### `GET /merchant/payment-preferences?publicKey=G...`
- **Description**: Reads the public, non-sensitive accepted-asset and preferred requested-asset settings for a Stellar wallet. An unconfigured wallet receives `{ acceptedAssets: ["XLM"], settlementAsset: "XLM", version: 0 }`.
- **Authorization**: Public; wallet public key is required and validated.
- **Feature gate**: Stellar testnet only, and `merchant.payment_preferences` must be enabled.
- **Response `200 OK`**: `{ "preferences": { "publicKey": "G...", "acceptedAssets": ["XLM", "USDC"], "settlementAsset": "USDC", "version": 1 } }`.
- **Errors**: `400 MERCHANT_PREFERENCES_MALFORMED`; `503 MERCHANT_PREFERENCES_DISABLED` or `MERCHANT_PREFERENCES_DEPENDENCY_FAILURE`.

#### `PUT /merchant/payment-preferences`
- **Description**: Saves wallet-authorized defaults for newly generated payment links. These preferences do not authorize a payment, initiate a path payment, move funds, or mutate existing links.
- **Authorization**: Ed25519 signature from `publicKey`; `Idempotency-Key` is required (16-128 URL-safe characters). No secret key or API key is sent.
- **Request Body**: `{ "publicKey": "G...", "expectedVersion": 0, "acceptedAssets": ["XLM", "USDC"], "settlementAsset": "USDC", "signedAt": 1792252800000, "signature": "<base64>" }`. The signature covers `QuickEx merchant payment preferences\n{publicKey}\n{expectedVersion}\n{signedAt}\n{sha256(JSON.stringify({acceptedAssets: sortedAssets, settlementAsset}))}`. Authorization expires after five minutes; an identical committed idempotent retry is replayable for 24 hours.
- **Validation**: `acceptedAssets` contains 1-8 unique members of `XLM`, `USDC`, `AQUA`, `yXLM`; `settlementAsset` must be included. Updates use optimistic `expectedVersion` and apply atomically with the idempotency record.
- **Errors**: `400 MERCHANT_PREFERENCES_MALFORMED`; `401 MERCHANT_PREFERENCES_UNAUTHORIZED`; `409 MERCHANT_PREFERENCES_CONFLICT`; `410 MERCHANT_PREFERENCES_EXPIRED`; `503 MERCHANT_PREFERENCES_DISABLED` or `MERCHANT_PREFERENCES_DEPENDENCY_FAILURE`.
- **Feature gate**: `merchant.payment_preferences` is enabled by default only in development/test and all writes are rejected outside testnet. Keep disabled on mainnet.

#### `POST /links/metadata`
- **Description**: Generates canonical payment link metadata, validation hashes, and accepted payment route parameters.
- **Authorization**: Public / Optional `X-API-Key`
- **Request Body**:
  ```json
  {
    "recipient": "alice",
    "amount": "25.50",
    "asset": "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    "memo": "Invoice #1042",
    "acceptedAssets": ["XLM", "USDC:GA5Z..."]
  }
  ```
- **Response `201 Created`**:
  ```json
  {
    "success": true,
    "data": {
      "linkId": "lnk_7f8a9b",
      "url": "https://quickex.to/pay/lnk_7f8a9b",
      "recipientAddress": "GABCD...",
      "amount": "25.50",
      "asset": "USDC:GA5Z...",
      "memo": "Invoice #1042",
      "expiresAt": "2026-09-25T12:00:00Z",
      "checksum": "sha256:4a8b..."
    }
  }
  ```
- **Error `400 Bad Request`**:
  ```json
  {
    "code": "VALIDATION_ERROR",
    "message": "Amount must be a positive decimal string.",
    "fields": {
      "amount": ["amount must be greater than 0"]
    }
  }
  ```

#### `GET /payment-links/status`
- **Description**: Checks current lifecycle status of a payment link (Active, Paid, Expired, Refunded).
- **Authorization**: Public
- **Query Parameters**: `username`, `amount`, `asset`, `memo`
- **Response `200 OK`**:
  ```json
  {
    "status": "ACTIVE",
    "isExpired": false,
    "paid": false,
    "expiresAt": "2026-09-25T12:00:00Z"
  }
  ```

#### `POST /links/bulk/generate`
- **Description**: Batch generation of payment links from structured CSV or JSON payloads.
- **Authorization**: Optional `X-API-Key` (Feature-gated: `bulk_link_generation`)
- **Request Body**: `{ "links": [ { ... }, { ... } ] }`
- **Response `200 OK`**: Per-row generation outcome with correlation keys.

---

### 3.5 Stellar & Soroban Routing

#### `GET /stellar/verified-assets`
- **Description**: Retrieves official directory of verified Stellar and Soroban assets with SEP-0001 TOML metadata, logos, and decimals.
- **Authorization**: Public
- **Headers Returned**: `ETag: "<hash>"`, `Cache-Control: public, max-age=60`
- **Response `200 OK`**:
  ```json
  {
    "assets": [
      {
        "code": "XLM",
        "issuer": null,
        "type": "native",
        "domain": "stellar.org",
        "decimals": 7
      },
      {
        "code": "USDC",
        "issuer": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        "type": "credit_alphanum4",
        "domain": "centre.io",
        "decimals": 7
      }
    ]
  }
  ```

#### `POST /stellar/path-preview`
- **Description**: Computes optimal strict-receive cross-asset paths across Horizon order books and Soroban AMMs.
- **Authorization**: Public / Optional `X-API-Key`
- **Request Body**:
  ```json
  {
    "sourceAccount": "GSOURCE...",
    "destAsset": "USDC:GA5Z...",
    "destAmount": "100.00"
  }
  ```
- **Response `200 OK`**: Candidate paths, required source amounts, path hops, and estimated slippage.

#### `POST /stellar/soroban-preflight`
- **Description**: Preflights Soroban contract execution via Soroban RPC simulation.
- **Authorization**: Public / Optional `X-API-Key`
- **Feature Gate**: `testnet.contract_writes` (Testnet only; 503 on Mainnet until post-audit).
- **Request Body**: `{ "sourceAccount": "GSOURCE..." }`
- **Response `200 OK`**: Simulation results, resource footprint, CPU instructions, and required auth entries.
- **Error `503 Service Unavailable`**:
  ```json
  {
    "code": "CONTRACT_NOT_CONFIGURED",
    "message": "Soroban contract ID is not configured on this network."
  }
  ```

---

### 3.6 Transactions (Non-Custodial Pipeline)

#### `GET /transactions`
- **Description**: Returns paginated transaction history for a given Stellar account address.
- **Authorization**: Public / Optional `X-API-Key`
- **Query Parameters**: `accountId` (required), `limit` (default 20, max 100), `cursor`
- **Response `200 OK`**: Paginated array of decoded Stellar transaction objects.

#### `POST /transactions/compose` (and compatibility alias `POST /transactions/build`)
- **Description**: Composes an unsigned Stellar transaction envelope for client-side signing. Preserves self-custody.
- **Authorization**: Optional `X-API-Key`
- **Feature Gate**: `testnet.contract_writes` on Testnet; disabled on Mainnet.
- **Request Body**:
  ```json
  {
    "sourceAccount": "GSOURCE...",
    "destinationAccount": "GDEST...",
    "amount": "50.00",
    "asset": "USDC:GA5Z...",
    "memo": "QuickEx Escrow #12"
  }
  ```
- **Response `200 OK`**:
  ```json
  {
    "unsignedXdr": "AAAAAgAAAAD...",
    "networkPassphrase": "Test SDF Network ; September 2015",
    "correlationId": "tx_req_8923a"
  }
  ```

---

### 3.7 Contract Registry & Rollback Governance

#### `GET /contracts/registry`
- **Description**: Retrieves currently active Soroban contract IDs and active WASM hashes by network.
- **Authorization**: Public
- **Headers Returned**: `ETag: "<registry-hash>"`
- **Response `200 OK`**:
  ```json
  {
    "network": "testnet",
    "contractId": "CD2J6K7T3YJ77QXZP3...",
    "wasmHash": "a1b2c3d4e5f6...",
    "version": 1,
    "updatedAt": "2026-09-20T00:00:00Z"
  }
  ```
- **Response `304 Not Modified`**: When client sends matching `If-None-Match`.

#### `POST /contracts/registry/publish`
- **Description**: Publishes a new contract deployment ID.
- **Authorization**: Admin Key (`@RequireScopes('admin')`)
- **Request Body**: `{ "network": "testnet", "contractId": "...", "wasmHash": "...", "version": 2 }`
- **Response `201 Created`**: Updated registry record.

#### `POST /contracts/registry/rollback`
- **Description**: Rollback active contract to the preceding verified deployment in the event of an exploit or critical defect.
- **Authorization**: Admin Key (`@RequireScopes('admin')`)
- **Response `200 OK`**: Rollback confirmation record.

---

### 3.8 Developer Self-Service & Webhooks

#### `GET /api-keys` & `POST /api-keys`
- **Description**: Manage developer API keys and rate tiers.
- **Authorization**: Wallet Authenticated
- **Response `201 Created`**: Includes plaintext API key string **once** upon creation.

#### `POST /webhooks/:publicKey`
- **Description**: Registers an automated HTTP webhook endpoint for payment event notifications.
- **Authorization**: API Key
- **Request Body**:
  ```json
  {
    "targetUrl": "https://merchant.example.com/webhooks/quickex",
    "events": ["payment.created", "payment.fulfilled", "escrow.funded"]
  }
  ```
- **Response `201 Created`**: Registered webhook with HMAC signing secret.

#### `POST /webhooks/verify-signature`
- **Description**: Utility endpoint to verify webhook payload HMAC signatures.
- **Authorization**: Public

---

## 4. Error Reference Matrix

| Error Code | HTTP Status | Description |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Payload failed schema validation rules. |
| `UNAUTHORIZED` | 401 | Missing or invalid API key or signature. |
| `FORBIDDEN` | 403 | Insufficient scope or mainnet feature-gate restriction. |
| `USERNAME_NOT_FOUND` | 404 | Target username is not registered in registry. |
| `NONCE_ALREADY_USED` | 409 | Nonce or transaction has already been processed (INV-07). |
| `RATE_LIMIT_EXCEEDED`| 429 | Exceeded burst or sustained request quota. |
| `DEPENDENCY_ERROR` | 502 | Upstream Stellar Horizon or Soroban RPC node error. |
| `SPEC_NOT_READY` | 503 | OpenAPI spec generator is bootstrapping. |
| `CONTRACT_NOT_CONFIGURED` | 503 | Requested smart contract is not deployed on this network. |

---

## 5. Security & Observability Guarantees

- **No Secret Logging**: Winston and Sentry loggers run redaction filters (`redaction.util.ts`) stripping private keys (`S...`), seed phrases, and database connection secrets.
- **Trace Context**: Every request carries an `X-Request-Id` or `correlationId` logged in JSON format for correlation with client SDKs.
- **Metrics**: Endpoints export Prometheus counters (`http_requests_total`) and latency histograms (`http_request_duration_seconds`).
