# API Changelog

All notable changes to the QuickEx public API are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to the versioning policy described in
[PUBLIC-API-REFERENCE.md](./PUBLIC-API-REFERENCE.md#versioning-policy).

## [Unreleased]

### Added

- Optional `Idempotency-Key` header for `POST /links/metadata`: concurrent requests with the same key and payload share one generation, and repeated requests replay the original response for five minutes; a conflicting payload returns `409 IDEMPOTENCY_CONFLICT` (`400 INVALID_IDEMPOTENCY_KEY` for a malformed key). Existing callers that omit the header are unaffected.

### Changed

- Nothing yet.

### Deprecated

- Nothing yet.

### Removed

- Nothing yet.

### Fixed

- Web and mobile link generators now ignore duplicate clicks/taps while a metadata request is in flight, and keep form values when a request fails.

### Security

- Nothing yet.

## [v1] - 2024-01-01

Initial public API release. This is the first versioned surface of the QuickEx
public API and covers the endpoints documented in
[PUBLIC-API-REFERENCE.md](./PUBLIC-API-REFERENCE.md).

### Added

- Public profile lookup: `GET /username/:username`.
- Profile editing: `PATCH /username/profile`.
- Payment link status: `GET /payment-links/status`.
- Receipts: `GET /v1/receipts/*`.
- Transaction lifecycle: `POST /transactions/submit`,
  `GET /transactions/:hash/status`, `POST /transactions/:hash/retry`.
- Stellar helpers under `/stellar/*` and analytics under `/analytics/*`.
- Contract registry reads and admin-scoped writes under `/contracts/registry`.
- Health and readiness probes: `/health`, `/ready`, `/status`.
- OpenAPI document served at `/docs`, `/docs/json`, and `/docs/openapi.json`.

### Notes

- The backend registers no global route prefix; controller prefixes are the
  full public paths. See
  [BACKEND-CLIENT-CONTRACT-MAP.md](./BACKEND-CLIENT-CONTRACT-MAP.md) for the
  client-facing contract map.
- Errors follow the global envelope `{ code, message, fields? }`.

[v1]: https://github.com/QuickEx/quickex/releases/tag/api-v1
