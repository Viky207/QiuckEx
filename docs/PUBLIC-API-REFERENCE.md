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
        "decimals": 7,
        "verified": true
      }
    ]
  }
  ```

---

## 4. Versioning Policy

The QuickEx public API is versioned so that third-party integrators can track
changes and migrate safely. This section defines how versions are bumped, the
deprecation timeline, and how breaking changes are announced.

### 4.1 URL Versioning Strategy

The public API uses **URL path versioning** with a `/v1/` prefix, for example:

```
https://api.quickex.to/v1/username/alice
https://api.quickex.to/v1/links/metadata
```

The version segment is the first path component after the host. Header-based
versioning (e.g. `Accept: application/vnd.quickex.v1+json`) is **not** used, so
clients can pin a version simply by choosing the correct base URL. The current
stable version is **v1**.

### 4.2 Semantic Versioning

API versions follow `vMAJOR` semantics:

- **MAJOR** (`v1` → `v2`): Introduced only for breaking changes. A new major
  version is published alongside the previous one; the previous version keeps
  working for the deprecation window described below.
- **Non-breaking additions** (new optional fields, new endpoints, new optional
  query parameters) are shipped within the current major version and recorded in
  [`docs/API-CHANGELOG.md`](./API-CHANGELOG.md) under `Added`.

### 4.3 What Counts as a Breaking Change

A change is **breaking** if it does any of the following:

- Removes a field from a response body.
- Changes the type of an existing field (e.g. `string` → `number`).
- Adds a new **required** request field or parameter.
- Changes an HTTP status code returned for an existing outcome.
- Removes or renames an endpoint, or changes its HTTP method.
- Changes authentication or authorization requirements for an existing endpoint.

Breaking changes require a new major version and a changelog entry under
`Changed`, `Removed`, or `Security` in
[`docs/API-CHANGELOG.md`](./API-CHANGELOG.md).

### 4.4 Deprecation Timeline

- Deprecated endpoints, fields, or parameters are announced in
  [`docs/API-CHANGELOG.md`](./API-CHANGELOG.md) under `Deprecated` and marked in
  this reference.
- Deprecated surface area remains functional for **at least 6 months** from the
  date of the deprecation announcement.
- Deprecated responses include a `Deprecation` header and a `Sunset` header
  (RFC 8594) indicating the removal date.
- After the 6-month window, the deprecated surface area may be removed in the
  next major version.

### 4.5 How Breaking Changes Are Announced

1. A new entry is added to [`docs/API-CHANGELOG.md`](./API-CHANGELOG.md)
   describing the change and its migration path.
2. The change is reflected in this reference and in
   [`docs/BACKEND-CLIENT-CONTRACT-MAP.md`](./BACKEND-CLIENT-CONTRACT-MAP.md) so
   backend clients can be updated in lockstep.
3. The new major version is published at its own `/vN/` base URL while the
   previous version continues to serve traffic for the deprecation window.
4. Any pull request that modifies `docs/openapi.json` must also update
   [`docs/API-CHANGELOG.md`](./API-CHANGELOG.md); this is enforced by CI.

---

## 5. Related Documents

- [`docs/API-CHANGELOG.md`](./API-CHANGELOG.md) — public API changelog.
- [`docs/BACKEND-CLIENT-CONTRACT-MAP.md`](./BACKEND-CLIENT-CONTRACT-MAP.md) — backend client contract map.
