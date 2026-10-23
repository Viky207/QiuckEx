//! Tests for the X-Ray proof verifier stub (issue #456).
//!
//! Format under test is documented in `app/contract/docs/ZK-PROOF-SPEC.md`.

use crate::{errors::QuickexError, QuickexContract, QuickexContractClient};
use soroban_sdk::{Bytes, BytesN, Env};

fn setup<'a>() -> (Env, QuickexContractClient<'a>) {
    let env = Env::default();
    let contract_id = env.register(QuickexContract, ());
    let client = QuickexContractClient::new(&env, &contract_id);
    (env, client)
}

/// Independent reference implementation of the spec (does not call contract code).
fn reference_commitment(env: &Env, amount: i128, blinding: &[u8; 32]) -> BytesN<32> {
    let mut preimage = Bytes::from_slice(env, b"QUICKEX_XRAY_COMMIT_V1");
    preimage.push_back(0x01);
    preimage.append(&Bytes::from_array(env, &amount.to_be_bytes()));
    preimage.append(&Bytes::from_array(env, blinding));
    env.crypto().sha256(&preimage).into()
}

fn build_proof(env: &Env, version: u8, amount: i128, blinding: &[u8; 32]) -> Bytes {
    let mut proof = Bytes::new(env);
    proof.push_back(version);
    proof.append(&Bytes::from_array(env, &amount.to_be_bytes()));
    proof.append(&Bytes::from_array(env, blinding));
    proof
}

const BLINDING: [u8; 32] = [0xA5; 32];

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

#[test]
fn test_verify_proof_valid_commitment_valid_proof_returns_true() {
    let (env, client) = setup();
    let amount = 1_500_000i128;
    let commitment = reference_commitment(&env, amount, &BLINDING);
    let proof = build_proof(&env, 0x01, amount, &BLINDING);

    assert_eq!(proof.len(), 49);
    assert!(client.verify_proof(&commitment, &proof));
}

#[test]
fn test_verify_proof_zero_and_max_amounts() {
    let (env, client) = setup();
    for amount in [0i128, 1, i128::MAX] {
        let commitment = reference_commitment(&env, amount, &BLINDING);
        let proof = build_proof(&env, 0x01, amount, &BLINDING);
        assert!(client.verify_proof(&commitment, &proof));
    }
}

#[test]
fn test_create_xray_commitment_matches_spec() {
    let (env, client) = setup();
    let amount = 42i128;
    let blinding = BytesN::from_array(&env, &BLINDING);

    let commitment = client.create_xray_commitment(&amount, &blinding);
    assert_eq!(commitment, reference_commitment(&env, amount, &BLINDING));

    let proof = build_proof(&env, 0x01, amount, &BLINDING);
    assert!(client.verify_proof(&commitment, &proof));
}

#[test]
fn test_create_xray_commitment_rejects_negative_amount() {
    let (env, client) = setup();
    let blinding = BytesN::from_array(&env, &BLINDING);
    let result = client.try_create_xray_commitment(&-1i128, &blinding);
    assert_eq!(result, Err(Ok(QuickexError::InvalidAmount)));
}

// ---------------------------------------------------------------------------
// Negative paths: valid commitment + invalid proof -> false
// ---------------------------------------------------------------------------

#[test]
fn test_verify_proof_valid_commitment_invalid_proof_returns_false() {
    let (env, client) = setup();
    let amount = 1_500_000i128;
    let commitment = reference_commitment(&env, amount, &BLINDING);

    // Wrong amount.
    let proof = build_proof(&env, 0x01, amount + 1, &BLINDING);
    assert!(!client.verify_proof(&commitment, &proof));
}

#[test]
fn test_verify_proof_wrong_blinding_returns_false() {
    let (env, client) = setup();
    let amount = 1_000i128;
    let commitment = reference_commitment(&env, amount, &BLINDING);
    let mut other = BLINDING;
    other[31] ^= 0x01;
    assert!(!client.verify_proof(&commitment, &build_proof(&env, 0x01, amount, &other)));
}

#[test]
fn test_verify_proof_unknown_or_reserved_version_returns_false() {
    let (env, client) = setup();
    let amount = 1_000i128;
    let commitment = reference_commitment(&env, amount, &BLINDING);
    for version in [0x00u8, 0x02, 0xFF] {
        let proof = build_proof(&env, version, amount, &BLINDING);
        assert!(!client.verify_proof(&commitment, &proof));
    }
}

#[test]
fn test_verify_proof_malformed_length_returns_false() {
    let (env, client) = setup();
    let amount = 1_000i128;
    let commitment = reference_commitment(&env, amount, &BLINDING);

    // Empty.
    assert!(!client.verify_proof(&commitment, &Bytes::new(&env)));

    // Truncated by one byte.
    let full = build_proof(&env, 0x01, amount, &BLINDING);
    assert!(!client.verify_proof(&commitment, &full.slice(0..48)));

    // Trailing garbage.
    let mut extended = full.clone();
    extended.push_back(0x00);
    assert!(!client.verify_proof(&commitment, &extended));
}

#[test]
fn test_verify_proof_negative_amount_returns_false() {
    let (env, client) = setup();
    // Commitment computed over a negative amount by the reference helper must
    // still be rejected: negative amounts are never valid openings.
    let commitment = reference_commitment(&env, -5, &BLINDING);
    let proof = build_proof(&env, 0x01, -5, &BLINDING);
    assert!(!client.verify_proof(&commitment, &proof));
}

#[test]
fn test_verify_proof_mismatched_commitment_returns_false() {
    let (env, client) = setup();
    let proof = build_proof(&env, 0x01, 1_000, &BLINDING);
    let wrong = BytesN::from_array(&env, &[0u8; 32]);
    assert!(!client.verify_proof(&wrong, &proof));
}

#[test]
fn test_verify_proof_not_interchangeable_with_escrow_commitment() {
    // Domain separation: an escrow amount commitment (KECCAK256 over owner ||
    // amount || salt) must never verify as an X-Ray commitment.
    use soroban_sdk::testutils::Address as _;
    let (env, client) = setup();
    let owner = soroban_sdk::Address::generate(&env);
    let salt = Bytes::from_array(&env, &BLINDING);
    let escrow_commitment = client.create_amount_commitment(&owner, &1_000, &salt);
    let proof = build_proof(&env, 0x01, 1_000, &BLINDING);
    assert!(!client.verify_proof(&escrow_commitment, &proof));
}
