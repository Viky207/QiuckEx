# Wallet Capability Compatibility Matrix

This document publishes the wallet capability compatibility matrix for the mobile app. The matrix is **derived from runtime capability probes** and describes which wallet operations are supported by each connection path, the network requirements for each, and the degraded behaviors that apply when a capability is unavailable.

> **Important:** Capabilities are discovered at runtime by the capability probe layer. This matrix is a snapshot of what the probes report. **When the probes change, this matrix must be regenerated** so it continues to match delivered behavior. Do not treat this document as the source of truth — the runtime probes are.

## How to read this matrix

- **Classic payment signing** and **Soroban auth-entry signing** are distinct capabilities. A wallet may support one without the other. Do not assume that a wallet able to sign a classic payment can also sign a Soroban authorization entry, or vice versa.
- **Supported** means the probe reports the capability as available for that wallet type and connection path.
- **Unsupported** means the probe reports the capability as unavailable; the app degrades as described in the *Degraded behavior* column.
- **Conditional** means support depends on network or configuration; see *Network requirements*.

## Capability definitions

| Capability | Description |
| --- | --- |
| `connect` | Establish a session with the wallet. |
| `getAddress` / `getPublicKey` | Retrieve the user's public key / account address. |
| `signClassicPayment` | Sign a classic Stellar payment (or other classic transaction) envelope. |
| `signSorobanAuthEntry` | Sign a Soroban authorization entry (`SorobanAuthorizationEntry`), used for contract invocations. |
| `signTransaction` (generic) | Sign an arbitrary transaction XDR. Support is wallet-dependent; see notes. |
| `networkPassphrase` awareness | Wallet is aware of / can be bound to the target network passphrase. |

## Matrix

### Freighter

| Connection path | connect | getAddress | Classic payment signing | Soroban auth-entry signing | Network requirements | Degraded behavior |
| --- | --- | --- | --- | --- | --- | --- |
| Browser extension (in-app browser / deep link) | Supported | Supported | Supported | Conditional — depends on extension version and Soroban support reported by the probe | Mainnet and Testnet; network passphrase must match the connected network | If Soroban signing is unsupported, contract-invocation flows are disabled with an explanatory message; classic payments remain available. |
| Mobile deep link / handoff | Supported | Supported | Supported | Unsupported unless the probe reports Soroban support | Same as above | Soroban flows fall back to "unsupported wallet" messaging; classic payments unaffected. |

### LOBSTR

| Connection path | connect | getAddress | Classic payment signing | Soroban auth-entry signing | Network requirements | Degraded behavior |
| --- | --- | --- | --- | --- | --- | --- |
| Mobile deep link / handoff | Supported | Supported | Supported | Unsupported (probe reports no Soroban auth-entry signing) | Mainnet and Testnet | Contract-invocation flows are disabled; user is prompted to use a Soroban-capable wallet. Classic payments remain available. |

### xBull

| Connection path | connect | getAddress | Classic payment signing | Soroban auth-entry signing | Network requirements | Degraded behavior |
| --- | --- | --- | --- | --- | --- | --- |
| Browser extension / in-app browser | Supported | Supported | Supported | Conditional — depends on extension version reported by the probe | Mainnet and Testnet; network passphrase must match | If Soroban signing is unsupported, contract-invocation flows are disabled with an explanatory message; classic payments remain available. |
| Mobile deep link / handoff | Supported | Supported | Supported | Conditional — depends on probe result | Same as above | Same as above. |

### Albedo

| Connection path | connect | getAddress | Classic payment signing | Soroban auth-entry signing | Network requirements | Degraded behavior |
| --- | --- | --- | --- | --- | --- | --- |
| Web / popup (deep link) | Supported | Supported | Supported | Conditional — depends on probe result for Soroban auth-entry signing | Mainnet and Testnet; network passphrase must match | If Soroban signing is unsupported, contract-invocation flows are disabled with an explanatory message; classic payments remain available. |

### Demo (in-app demo wallet)

| Connection path | connect | getAddress | Classic payment signing | Soroban auth-entry signing | Network requirements | Degraded behavior |
| --- | --- | --- | --- | --- | --- | --- |
| In-app demo | Supported | Supported | Supported | Supported (local signing for demo/testing only) | Testnet recommended; demo signing does not touch the network | Not applicable — demo wallet always reports full capability for testing. Never use for real funds. |

## Distinguishing classic payment signing from Soroban auth-entry signing

- **Classic payment signing** covers classic Stellar transactions (payments, path payments, account operations). It is the most widely supported capability across wallets.
- **Soroban auth-entry signing** covers signing `SorobanAuthorizationEntry` structures required for smart-contract invocations. Support is narrower and version-dependent. A wallet that supports classic payment signing is **not** guaranteed to support Soroban auth-entry signing.
- The app must query the probe for each capability independently and must not infer one from the other.

## Network requirements

- All non-demo wallets require the app's configured network passphrase to match the wallet's connected network (Mainnet or Testnet). A mismatch is treated as an unsupported configuration and the affected operation is disabled with an explanatory message.
- The demo wallet performs local signing and is intended for Testnet/testing only.

## Degraded behaviors (summary)

| Situation | Behavior |
| --- | --- |
| Wallet supports classic signing but not Soroban auth-entry signing | Classic payments remain available; contract-invocation flows are disabled with an explanatory message and a prompt to use a Soroban-capable wallet. |
| Network passphrase mismatch | The affected operation is disabled with an explanatory message; no signing request is sent. |
| Probe reports wallet unsupported entirely | The wallet is not offered as a connection option; existing sessions degrade to read-only where applicable. |
| Probe unavailable / indeterminate | Capabilities are treated as unsupported (fail closed) until the probe succeeds; the user is informed that capabilities could not be determined. |

## Regenerating this matrix

This matrix is derived from the runtime capability probes. When probe definitions or wallet capabilities change:

1. Re-run the capability probes against each wallet type and connection path.
2. Update the *Matrix* tables above to match the probe results.
3. Update the *Degraded behaviors* summary if any fallback paths changed.
4. Keep the classic-payment vs. Soroban-auth-entry distinction explicit in every update.

Do not log secrets, signing material, or unnecessary personal data when running or updating probes.