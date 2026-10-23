# X-Ray Proof Specification (`verify_proof`)

Issue: #456 · Status: **Experimental — testnet MVP stub, not zero-knowledge**

This document defines the on-chain proof format accepted by
`QuickexContract::verify_proof` (`contracts/quickex/src/zk_verifier.rs`). The
backend uses it to submit X-Ray privacy proofs to the Soroban contract.

> [!WARNING]
> Version `0x01` is a **hash-commitment opening**, not a zero-knowledge proof.
> Submitting the proof reveals the amount and blinding factor to anyone reading
> the transaction. It provides hiding *until* the proof is submitted and
> binding at all times. Do not market it as ZK privacy. Mainnet use is blocked
> (see [CAPABILITY-MAP.md](../../../docs/CAPABILITY-MAP.md)).

## Contract interface

```rust
/// Pure view: no storage, no auth, no events. Never panics on malformed input.
fn verify_proof(env: Env, commitment: BytesN<32>, proof: Bytes) -> bool;

/// Reference helper for client conformance testing.
/// Errors: InvalidAmount (100) if amount < 0.
fn create_xray_commitment(env: Env, amount: i128, blinding: BytesN<32>)
    -> Result<BytesN<32>, QuickexError>;
```

`verify_proof` returns `true` only when `proof` is a well-formed, supported
version **and** it opens `commitment`. Every other case returns `false`
(unknown version, wrong length, negative amount, mismatch).

## Proof envelope

Every proof starts with a 1-byte version tag so new proof systems can be
added behind the same entry point without changing the contract ABI.

| Version | Scheme | Status |
|---|---|---|
| `0x00` | — | Invalid (always `false`) |
| `0x01` | SHA-256 hash-commitment opening | **Implemented** (testnet MVP) |
| `0x02` | Groth16 over BLS12-381 | Reserved, returns `false` |
| `0x03`–`0xFF` | — | Reserved, returns `false` |

## Version `0x01` — SHA-256 hash-commitment opening

### Commitment

```text
commitment = SHA256( DOMAIN_TAG || 0x01 || BE128(amount) || blinding )
```

| Field | Size | Encoding |
|---|---|---|
| `DOMAIN_TAG` | 22 bytes | ASCII `QUICKEX_XRAY_COMMIT_V1` |
| version | 1 byte | `0x01` |
| `amount` | 16 bytes | Big-endian two's-complement `i128`, must be `>= 0` |
| `blinding` | 32 bytes | Uniformly random, from a CSPRNG, never reused |

The domain tag separates X-Ray commitments from escrow amount commitments
(`KECCAK256(XDR(owner) || BE128(amount) || salt)`, see `commitment.rs`), so a
value from one scheme can never verify under the other.

### Proof

Exactly **49 bytes**:

```text
offset  0       1                     17                                49
        +-------+---------------------+----------------------------------+
        | 0x01  |  BE128(amount) (16) |        blinding (32)             |
        +-------+---------------------+----------------------------------+
```

### Verification algorithm

1. If `proof` is empty or `proof[0] != 0x01` → `false`.
2. If `len(proof) != 49` → `false`.
3. Decode `amount = i128::from_be_bytes(proof[1..17])`; if `amount < 0` → `false`.
4. `blinding = proof[17..49]`.
5. Return `SHA256(DOMAIN_TAG || 0x01 || proof[1..17] || blinding) == commitment`.

### Test vector

```text
amount     = 1500000           (0x0000000000000000000000000016E360)
blinding   = 0xA5 repeated 32 times
proof      = 01 000000000000000000000000 0016E360 A5A5…A5   (49 bytes)
commitment = SHA256("QUICKEX_XRAY_COMMIT_V1" || 01 || 00…0016E360 || A5…A5)
```

`zk_verifier_test.rs` contains an independent reference implementation used to
cross-check the contract; backend implementations should reproduce
`create_xray_commitment` byte-for-byte.

### Backend example (TypeScript)

```ts
import { createHash, randomBytes } from 'crypto';

const TAG = Buffer.from('QUICKEX_XRAY_COMMIT_V1', 'ascii');

function be128(amount: bigint): Buffer {
  if (amount < 0n) throw new Error('amount must be >= 0');
  const b = Buffer.alloc(16);
  b.writeBigUInt64BE(amount >> 64n, 0);
  b.writeBigUInt64BE(amount & 0xffffffffffffffffn, 8);
  return b;
}

export function makeXrayProof(amount: bigint) {
  const blinding = randomBytes(32);
  const amt = be128(amount);
  const commitment = createHash('sha256')
    .update(Buffer.concat([TAG, Buffer.from([0x01]), amt, blinding]))
    .digest();                                        // BytesN<32>
  const proof = Buffer.concat([Buffer.from([0x01]), amt, blinding]); // 49 bytes
  return { commitment, proof, blinding };
}
```

## Security properties and limitations

| Property | v0x01 |
|---|---|
| Binding | Yes (SHA-256 collision resistance) |
| Hiding before submission | Yes (32-byte random blinding) |
| Hiding after submission | **No** — amount and blinding are public in the tx |
| Sender privacy | **No** — the submitter is visible on-chain |
| Range proof | Only `amount >= 0` is checked |
| Replay protection | None at the verifier; callers that act on a proof must track spent commitments |

## Upgrade path (version `0x02`)

The intended production scheme is Groth16 over BLS12-381 using the Soroban
`env.crypto().bls12_381()` host functions (pairing check). Planned envelope:

```text
0x02 || A (G1, 96 B) || B (G2, 192 B) || C (G1, 96 B) || public inputs …
```

with the verifying key stored under an admin/governance-controlled key and the
X-Ray commitment exposed as a public input. Adding it requires a new match arm
in `zk_verifier::verify_proof` only; the `verify_proof(BytesN<32>, Bytes)` ABI
stays the same.
