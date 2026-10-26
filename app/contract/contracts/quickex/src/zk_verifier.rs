//! # X-Ray proof verifier (testnet MVP stub)
//!
//! On-chain verifier entry point for X-Ray privacy mode (issue #456). The
//! backend submits a `(commitment, proof)` pair and the contract answers
//! `true` / `false`.
//!
//! ## Status: placeholder, NOT zero-knowledge
//!
//! A real ZK verifier (e.g. Groth16 over BLS12-381 using the Soroban
//! `env.crypto().bls12_381()` host functions) is deferred. For the testnet MVP
//! this module implements a **SHA-256 hash-commitment opening** check:
//!
//! ```text
//! commitment = SHA256(DOMAIN_TAG || version || BE128(amount) || blinding)
//! proof      = version (1 byte) || BE128(amount) (16 bytes) || blinding (32 bytes)
//! ```
//!
//! The proof *reveals* the amount and blinding factor to the verifier, so it is
//! hiding only until it is submitted. The `proof: Bytes` shape and the leading
//! version byte are deliberately kept so a future Groth16 proof (version
//! `0x02`) can be dispatched through the same entry point without an ABI
//! change. See `app/contract/docs/ZK-PROOF-SPEC.md` for the full format.
//!
//! ## Guarantees
//!
//! - Never panics on malformed input; any malformed proof returns `false`.
//! - Pure: reads no storage, emits no events, requires no auth.

use soroban_sdk::{Bytes, BytesN, Env};

/// Domain-separation tag so X-Ray commitments can never collide with the
/// escrow amount commitments in [`crate::commitment`].
pub const XRAY_DOMAIN_TAG: &[u8] = b"QUICKEX_XRAY_COMMIT_V1";

/// Proof format version for the SHA-256 hash-commitment opening.
pub const PROOF_VERSION_SHA256_OPENING: u8 = 0x01;

/// Byte length of the version prefix.
const VERSION_LEN: u32 = 1;
/// Byte length of a big-endian `i128` amount.
const AMOUNT_LEN: u32 = 16;
/// Byte length of the blinding factor.
pub const BLINDING_LEN: u32 = 32;
/// Exact byte length of a version `0x01` proof.
pub const SHA256_OPENING_PROOF_LEN: u32 = VERSION_LEN + AMOUNT_LEN + BLINDING_LEN;

/// Compute the X-Ray commitment for `amount` and a 32-byte `blinding` factor.
///
/// This is the reference construction the backend must reproduce off-chain.
/// Returns `None` if `amount` is negative.
pub fn compute_commitment(env: &Env, amount: i128, blinding: &BytesN<32>) -> Option<BytesN<32>> {
    if amount < 0 {
        return None;
    }
    let mut preimage = Bytes::from_slice(env, XRAY_DOMAIN_TAG);
    preimage.push_back(PROOF_VERSION_SHA256_OPENING);
    preimage.append(&Bytes::from_array(env, &amount.to_be_bytes()));
    preimage.append(&Bytes::from(blinding.clone()));
    Some(env.crypto().sha256(&preimage).into())
}

/// Verify that `proof` is a valid opening of `commitment`.
///
/// Returns `false` for unknown versions, wrong lengths, negative amounts, or
/// a commitment mismatch.
pub fn verify_proof(env: &Env, commitment: &BytesN<32>, proof: &Bytes) -> bool {
    if proof.is_empty() {
        return false;
    }
    match proof.get(0) {
        Some(PROOF_VERSION_SHA256_OPENING) => verify_sha256_opening(env, commitment, proof),
        // 0x02 is reserved for Groth16 (BLS12-381); not yet implemented.
        _ => false,
    }
}

fn verify_sha256_opening(env: &Env, commitment: &BytesN<32>, proof: &Bytes) -> bool {
    if proof.len() != SHA256_OPENING_PROOF_LEN {
        return false;
    }

    let mut amount_bytes = [0u8; AMOUNT_LEN as usize];
    proof
        .slice(VERSION_LEN..VERSION_LEN + AMOUNT_LEN)
        .copy_into_slice(&mut amount_bytes);
    let amount = i128::from_be_bytes(amount_bytes);

    let mut blinding_bytes = [0u8; BLINDING_LEN as usize];
    proof
        .slice(VERSION_LEN + AMOUNT_LEN..SHA256_OPENING_PROOF_LEN)
        .copy_into_slice(&mut blinding_bytes);
    let blinding = BytesN::from_array(env, &blinding_bytes);

    match compute_commitment(env, amount, &blinding) {
        Some(expected) => expected == *commitment,
        None => false,
    }
}
