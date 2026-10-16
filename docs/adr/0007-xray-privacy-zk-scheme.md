# ADR-0007: Use Groth16 over BN254 for X-Ray privacy proofs

## Status

Accepted <!-- Proposed | Accepted | Rejected | Deprecated | Superseded by ADR-NNNN -->

## Context

X-Ray privacy lets a user prove facts about a shielded balance (for example, that
a withdrawal is covered) without revealing the underlying amounts or the note
that funds it. The proof is verified on-chain inside a Soroban contract, so the
choice of proving system is constrained by three things at once:

- **Custody sensitivity.** X-Ray moves real value on mainnet. A soundness bug in
the proof system is a direct loss-of-funds bug, so the scheme must be one with a
long track record and well-understood security proofs.
- **On-chain verification cost.** Soroban meters CPU instructions and memory per
invocation. Verification must fit comfortably inside the per-transaction budget
so that a withdrawal is not priced out of reach.
- **Tooling maturity.** The circuit framework must be maintained, auditable, and
usable by contributors without bespoke cryptography work.

The privacy circuit and its verifier are owned by the X-Ray contract module
(`app/contract/`), with the circuit sources alongside it. The threat model that
motivates the privacy requirement is recorded in
[../CUSTODY-TRUST-THREAT-MODEL.md](../CUSTODY-TRUST-THREAT-MODEL.md).

## Decision

X-Ray privacy proofs use **Groth16** over the **BN254** curve, with circuits
written in **arkworks** (`ark-groth16`, `ark-bn254`, `ark-relations`).

Specific rules this establishes:

- The verifier embedded in the X-Ray contract is a Groth16 verifier for BN254.
  Its verifying key is a contract-level constant and is versioned with the
  circuit; a circuit change requires a new verifying key and a contract upgrade.
- Proofs are constant-size (three group elements) and verification is a fixed
  number of pairing and group operations, independent of circuit size. This is
  what keeps the Soroban instruction cost bounded and predictable.
- The circuit is compiled with arkworks and the proving/verifying keys are
  produced by a **trusted setup** (see below). The setup transcript and the
  resulting verifying key hash are recorded in the repository so that the
  deployed verifier can be checked against the audited artifact.
- Public inputs are limited to the statement the contract must check (for
example, a commitment and a nullifier). Everything else stays private.

## Alternatives Considered

- **PLONK / Halo2 (universal or transparent setup).** Removes the per-circuit
trusted-setup ceremony and supports a universal SRS, which is attractive
operationally. Rejected for now because verification is heavier than Groth16
(more pairings and a larger verifier), which pushes the Soroban instruction cost
up, and because the arkworks/Halo2 tooling we would depend on is less battle-
tested for our circuit size. Revisit if the trusted setup becomes a blocker.
- **STARKs (transparent, post-quantum).** No trusted setup and transparent
verification, but proof sizes are orders of magnitude larger and verification is
far more expensive. The on-chain cost is prohibitive for a per-withdrawal proof
on Soroban today.
- **Bulletproofs / range proofs only.** Sufficient for range statements but not
for the general relation X-Ray needs (membership plus nullifier correctness),
and verification cost grows with the statement size.
- **Off-chain verification with an on-chain attestation.** Moves trust to the
attesting party and reintroduces exactly the custodian the feature is meant to
remove. Rejected on principle.

## Consequences

- **Easier:** verification cost is small and constant, so withdrawal pricing is
stable and independent of circuit complexity; the verifier is a small, auditable
amount of code; proofs are compact, keeping transaction size low.
- **Harder:** every circuit change needs a new trusted setup and a contract
upgrade, so circuit iteration is a deliberate, coordinated process rather than a
hotfix. Contributors must not change the circuit without regenerating and
re-recording the verifying key.
- **Degraded mode:** if a proof fails to verify, the withdrawal is rejected and
no state changes; there is no partial-credit path. If the verifier or its
verifying key is unavailable or mismatched, the contract must fail closed.
- Contributors adding a new statement must add it as a public input, extend the
circuit, run the setup, and update the recorded verifying key hash in the same
change.

## Reversal Cost

HIGH. Switching proving systems means rewriting the circuit, regenerating keys,
replacing the on-chain verifier, and re-auditing the custody path. Reversal is
owned by the X-Ray maintainers and requires a new ADR superseding this one plus a
contract upgrade.

## Invariants Affected

- [../INVARIANTS.md](../INVARIANTS.md) — value-conservation and no-double-spend
  invariants for shielded balances: a withdrawal must be covered by a valid note
  and must consume a fresh nullifier, both enforced by the proof.

## Security Considerations

- **Trusted setup.** Groth16 requires a per-circuit trusted setup. If the toxic
  waste is retained, a holder can forge proofs and mint value from nothing. The
  ceremony must be multi-party with at least one honest participant, and the
  transcript must be published and independently verified. The verifying key
  hash is pinned in the repository and checked against the deployed verifier.
- **Soundness assumptions.** Security rests on the BN254 pairing assumptions and
  the Groth16 soundness proof. BN254 is not post-quantum; a future
  cryptographically-relevant quantum computer would break soundness. This is
  accepted for now and tracked as a long-horizon risk.
- **Public-input binding.** The contract must bind every public input the
  statement depends on (commitment, nullifier, and any domain separator) so that
  a valid proof cannot be replayed in a different context.
- **Nullifier uniqueness.** The contract must reject a nullifier that has
  already been spent; the proof guarantees correctness of the nullifier, not its
  freshness.
- **Verifying-key integrity.** A mismatch between the audited verifying key and
  the deployed one is a critical failure; the recorded hash exists to make that
  detectable.
- **Soroban instruction cost.** Verification is a fixed sequence of BN254
  pairings and group operations. The exact instruction count must be measured
  against the current Soroban budget before mainnet and re-measured on protocol
  upgrades; the constant-size property is what makes this estimate stable.

## References

- Owning code paths: `app/contract/` (X-Ray contract and verifier), circuit
  sources and recorded verifying key hash alongside it.
- Contract implementation issue: #372.
- [../CUSTODY-TRUST-THREAT-MODEL.md](../CUSTODY-TRUST-THREAT-MODEL.md)
- [../INVARIANTS.md](../INVARIANTS.md)
- [TEMPLATE.md](TEMPLATE.md)
