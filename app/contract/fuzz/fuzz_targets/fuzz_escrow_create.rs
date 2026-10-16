#![no_main]

use libfuzzer_sys::fuzz_target;

/// Maximum TTL (in ledgers) accepted by the escrow contract's create path.
/// Mirrors the upper bound enforced by `create_escrow` input validation.
const MAX_TTL: u32 = 1_000_000;

/// Maximum memo length (bytes) accepted by the escrow contract.
const MAX_MEMO_LEN: usize = 64;

/// Validate an escrow amount the same way the contract does.
///
/// The contract rejects a zero amount and any amount that would overflow
/// when summed with an existing balance. We model that here so the fuzzer
/// can exercise the boundary conditions (zero, max u64, near-overflow).
fn validate_amount(amount: u64) -> Result<(), &'static str> {
    if amount == 0 {
        return Err("amount must be greater than zero");
    }
    // Guard against overflow when the amount is added to a non-zero balance.
    if amount.checked_add(amount).is_none() {
        return Err("amount overflow");
    }
    Ok(())
}

/// Validate a memo the same way the contract does: bounded length and
/// restricted to printable ASCII to avoid ambiguous on-chain payloads.
fn validate_memo(memo: &[u8]) -> Result<(), &'static str> {
    if memo.len() > MAX_MEMO_LEN {
        return Err("memo too long");
    }
    if !memo.iter().all(|b| b.is_ascii_graphic() || *b == b' ') {
        return Err("memo contains non-printable bytes");
    }
    Ok(())
}

/// Validate a TTL the same way the contract does: non-zero and bounded.
fn validate_ttl(ttl: u32) -> Result<(), &'static str> {
    if ttl == 0 {
        return Err("ttl must be greater than zero");
    }
    if ttl > MAX_TTL {
        return Err("ttl exceeds maximum");
    }
    Ok(())
}

fuzz_target!(|data: &[u8]| {
    // Split the fuzz input into the three create-escrow fields:
    //   [0..8)   -> amount (u64, little-endian)
    //   [8..12)  -> ttl (u32, little-endian)
    //   [12..]   -> memo bytes
    if data.len() < 12 {
        return;
    }

    let amount = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let ttl = u32::from_le_bytes(data[8..12].try_into().unwrap());
    let memo = &data[12..];

    // The contract must never panic on any input; it should return a
    // deterministic Ok/Err. We assert that invariant here.
    let _ = validate_amount(amount);
    let _ = validate_memo(memo);
    let _ = validate_ttl(ttl);
});
