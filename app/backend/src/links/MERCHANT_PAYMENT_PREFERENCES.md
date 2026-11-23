# Merchant Payment Preferences (Requested-Asset Hints)

This document describes **merchant payment preferences** as implemented in the links module. Preferences are **requested-asset hints**: they tell a payer which asset a merchant would *prefer* to receive. They are **not** an exchange, conversion, or settlement mechanism.

> **Important:** Preferences **never convert funds**. If a payer sends a different accepted asset than the preferred one, the merchant simply receives that asset. No swap, no automatic exchange, and no settlement is performed by this feature.

## Scope

- **Testnet-only.** The feature is available only on testnet.
- **Feature-flag gated.** It is disabled unless the corresponding feature flag is enabled.
- **No automatic exchange or settlement.** Preferences are advisory hints only.
- **Mainnet gate.** On mainnet the endpoints are unavailable (feature flag off / testnet gate rejects the request).

## Accepted assets

A merchant declares the set of assets it will accept. Each accepted asset is identified by its asset code/issuer (or native asset identifier) as used elsewhere in the links module. The accepted-assets list is the authoritative set of what a payer may send.

## Preferred requested asset (`settlementAsset`)

Among the accepted assets, the merchant may designate a single **preferred requested asset**, expressed as `settlementAsset`. This is a *hint* to the payer about which accepted asset the merchant would prefer to receive.

- `settlementAsset` **must** be one of the accepted assets.
- `settlementAsset` is optional; when omitted, no preference is expressed.
- Despite the field name, `settlementAsset` does **not** trigger settlement or conversion. It only signals preference.

## Signature authorization

Saving preferences requires a signed request from the merchant:

- **Canonical message.** The request is authorized by a signature over a canonical message derived from the request payload (including the accepted assets, the preferred `settlementAsset`, and `signedAt`). The canonical form must be reproduced exactly by the signer.
- **`signedAt` TTL.** The `signedAt` timestamp must be within the allowed time-to-live window; stale or future-dated signatures are rejected.
- **Idempotency key.** Requests carry an idempotency key so that retries are safe and do not create duplicate or conflicting preference records.

Do not log signing material or secrets. Only non-sensitive metadata should be logged.

## Request / response schema

### Request body (`SaveMerchantPaymentPreferencesDto`)

```json
{
  "acceptedAssets": ["USDC:GA5Z...", "XLM"],
  "settlementAsset": "USDC:GA5Z...",
  "signedAt": "2024-01-01T00:00:00.000Z",
  "signature": "base64-encoded-signature",
  "idempotencyKey": "unique-idempotency-key"
}
```

Field notes:

- `acceptedAssets` — array of accepted asset identifiers (required).
- `settlementAsset` — preferred requested asset; must be a member of `acceptedAssets` (optional).
- `signedAt` — ISO-8601 timestamp used for TTL validation (required).
- `signature` — signature over the canonical message (required).
- `idempotencyKey` — key for safe retries (required).

### Response

```json
{
  "preferences": {
    "acceptedAssets": ["USDC:GA5Z...", "XLM"],
    "settlementAsset": "USDC:GA5Z...",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

The response is always wrapped as `{ preferences: MerchantPaymentPreferences }`.

## Failure and boundary cases

- `settlementAsset` not present in `acceptedAssets` → request rejected.
- `signedAt` outside the TTL window → request rejected.
- Missing or invalid signature → request rejected.
- Reused `idempotencyKey` with a different payload → conflict rejected.
- Feature flag disabled or mainnet → request rejected by the gate.

## Related files

- Controller: `app/backend/src/links/merchant-payment-preferences.controller.ts`
- Service: `app/backend/src/links/merchant-payment-preferences.service.ts`
- Repository: `app/backend/src/links/merchant-payment-preferences.repository.ts`
- DTO: `SaveMerchantPaymentPreferencesDto` (in the links module DTOs)