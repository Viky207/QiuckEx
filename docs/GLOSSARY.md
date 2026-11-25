# Glossary — Stellar & QuickEx Terminology

This glossary defines the single preferred meaning of each term used across Stellar and QuickEx product and protocol documentation. Where a term has a canonical implementation or policy, it is linked. If a term is used differently anywhere in the codebase or docs, this glossary is authoritative and the usage should be corrected.

> **Status:** Living document. Add terms here before introducing them in specs, API docs, or UI copy.

---

## How to read this glossary

- **Preferred meaning** — the one definition teams should use.
- **Canonical source** — the implementation or policy file that defines the behavior.
- **Not to be confused with** — common misuses and the correct term to use instead.

---

## Core protocol terms (Stellar)

### Asset
A unit of value on the Stellar network, identified by a **canonical asset identity** consisting of an asset code and, for non-native assets, an issuer account. The native asset (XLM) has no issuer.

- **Canonical source:** `app/backend/src/links/payment-link.service.ts` (canonical asset identity construction and comparison)
- **Not to be confused with:** "token" (avoid), "currency" (avoid — use *asset*), or a *requested asset* / *settlement asset* (those are roles an asset plays in a payment; see below).

### Issuer
The Stellar account that issues a non-native asset and controls its supply. An asset is uniquely identified by the pair (asset code, issuer). Two assets with the same code but different issuers are **different assets**.

- **Canonical source:** `app/backend/src/links/payment-link.service.ts`
- **Not to be confused with:** the *sender* or *receiver* of a payment (those are parties, not issuers).

### Network
The Stellar network environment a transaction targets — **mainnet** (public) or **testnet**. Assets, issuers, and accounts are network-specific; an asset on testnet is not the same asset as one with the same code/issuer on mainnet.

- **Canonical source:** network configuration in `app/backend/src/config/` (network passphrase and Horizon URL selection)
- **Not to be confused with:** "environment" in the deployment sense (staging/production); always qualify as *Stellar network*.

### Reserve
The minimum XLM balance an account must hold to remain active on Stellar, plus any additional XLM locked per trustline, offer, or data entry. Reserve requirements are a protocol-level constraint, not a QuickEx fee.

- **Canonical source:** Stellar protocol (base reserve and per-entry reserve); surfaced in balance/account checks in `app/backend/src/`
- **Not to be confused with:** an escrow balance or a payment amount held for settlement.

### Trustline
An explicit opt-in from a Stellar account authorizing it to hold a specific non-native asset from a specific issuer. An account cannot receive an asset it has no trustline for.

- **Canonical source:** Stellar protocol; enforced during payment/claim flows in `app/backend/src/`
- **Not to be confused with:** asset *verification* (see *Verified asset*), which is a QuickEx trust signal, not a protocol requirement.

---

## QuickEx product terms

### Payment link
A QuickEx-created, shareable link that encodes a payment request (amount, requested asset, receiver, and metadata). Opening the link lets a payer complete the payment.

- **Canonical source:** `app/backend/src/links/payment-link.service.ts`
- **Not to be confused with:** a *payment intent* (the resolved, actionable payment derived from a link) or a raw Stellar payment operation.

### Payment intent
The resolved, actionable intent to pay produced from a payment link (or other request source): who pays, how much, in which **requested asset**, to whom, and under what conditions. A payment intent is a QuickEx concept; it is not itself a Stellar transaction.

- **Canonical source:** `app/backend/src/links/payment-link.service.ts` (intent resolution) and related payment services in `app/backend/src/`
- **Not to be confused with:** a Stellar *transaction* (the on-chain submission) or a *payment link* (the shareable request).

### Requested asset
The asset the receiver asks to be paid in — the asset named in the payment link / payment intent. This is the *denomination of the request*, not necessarily the asset that ultimately settles the payment.

- **Canonical source:** `app/backend/src/links/payment-link.service.ts`
- **Not to be confused with:** the *settlement asset* (what actually moves on-chain) or the *conversion* (the step that bridges the two).

### Settlement asset
The asset that actually moves on the Stellar network to discharge a payment intent. When no conversion occurs, the settlement asset equals the requested asset. When a conversion occurs, they differ.

- **Canonical source:** payment execution/settlement logic in `app/backend/src/`
- **Not to be confused with:** the *requested asset* (the ask) — always state which role an asset plays.

### Conversion
The process of exchanging one asset for another so that a payment made in one asset satisfies a request denominated in a different asset (e.g. payer holds asset A, receiver requested asset B). Conversion is an explicit step; it is **not** implied by naming a requested asset.

- **Canonical source:** conversion/swap handling in `app/backend/src/`
- **Not to be confused with:** *settlement* (the movement of the final asset) — conversion may precede settlement but is distinct from it.

> **Requested asset vs. settlement asset vs. conversion — the explicit distinction:**
> - **Requested asset** = what the receiver asked for (the denomination of the request).
> - **Settlement asset** = what actually moves on-chain to complete the payment.
> - **Conversion** = the optional step that transforms value from one asset into another so settlement can satisfy the request.
>
> If requested asset = settlement asset, no conversion is needed. If they differ, a conversion must occur (or be explicitly declined) before settlement. Never use "asset" unqualified when the role matters.

### Escrow
A QuickEx mechanism that holds funds under defined release conditions until a payment or agreement completes. Escrow balances are distinct from Stellar *reserves* and from settled payments.

- **Canonical source:** escrow services in `app/backend/src/`
- **Not to be confused with:** Stellar *reserve* (a protocol minimum balance) or a pending *payment intent* (an intent is not yet funds held).

### Verified asset / Unverified asset
A QuickEx trust classification for a non-native asset, based on asset metadata and issuer checks. **Verified** means the asset matches QuickEx's metadata/issuer criteria; **unverified** means it does not (or has not been checked). This is a QuickEx signal and does not change the asset's on-chain identity.

- **Canonical source:** `app/backend/src/asset-metadata/asset-metadata.service.ts`
- **Not to be confused with:** a *trustline* (a protocol requirement to hold an asset) — verification is a trust signal, not a protocol gate.

### Asset metadata
Descriptive and verification data associated with an asset (e.g. display name, domain, verification status) maintained by QuickEx. Metadata does not alter canonical asset identity (code + issuer).

- **Canonical source:** `app/backend/src/asset-metadata/asset-metadata.service.ts`
- **Not to be confused with:** the *canonical asset identity* itself, which is defined solely by code and issuer.

---

## Terms to avoid / preferred replacements

| Avoid | Use instead |
| --- | --- |
| token, coin, currency | **asset** |
| "the asset" (when role matters) | **requested asset** or **settlement asset** |
| "swap" (in product docs) | **conversion** |
| "minimum balance" (ambiguous) | **reserve** |
| "approved asset" | **verified asset** |
| "link payment" | **payment link** / **payment intent** (as appropriate) |

---

## Maintenance

- When adding a new term, add it here with one preferred meaning and a canonical source link.
- When an implementation file moves, update the link in this glossary in the same change.
- If a term's meaning changes, treat it as a deliberate migration and update all affected docs and API descriptions together.