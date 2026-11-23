//! # QuickEx Storage Schema
//!
//! This module defines the persistent storage layout for the QuickEx contract.
//! All long-term data is stored via the [`DataKey`] enum, which centralises key
//! construction and ensures type-safe storage access.
//!
//! ## Key Layout
//!
//! | Key Variant            | Value Type     | Description |
//! |------------------------|----------------|-------------|
//! | [`Escrow`](DataKey::Escrow) | `EscrowEntry`  | Legacy escrow entry keyed by commitment hash (32 bytes). Read as a fallback during lazy migration. |
//! | [`EscrowCore`](DataKey::EscrowCore) | `CompactEscrowEntry` | Compact escrow record used for new writes and hot-path reads. |
//! | [`EscrowDispute`](DataKey::EscrowDispute) | `EscrowDisputeConfig` | Optional dispute-only metadata written only when an escrow uses arbiters. |
//! | [`EscrowCounter`](DataKey::EscrowCounter) | `u64`       | Global monotonic counter for escrow creation. |
//! | [`ContractVersion`](DataKey::ContractVersion) | `u32` | Stored schema/version marker for upgrade migrations. |
//! | [`Admin`](DataKey::Admin) | `Address`     | Contract admin address. Set during initialisation, transferable by admin. |
//! | [`Paused`](DataKey::Paused) | `bool`       | Global pause flag. When true, critical operations may be blocked. |
//! | [`PrivacyLevel`](DataKey::PrivacyLevel) | `u32`  | Numeric privacy level per account (0 = off). Used by `enable_privacy`. |
//! | [`PrivacyHistory`](DataKey::PrivacyHistory) | `Vec<u32>` | Per-account history of privacy level changes (chronological). |
//!
//! ## Related Keys (legacy compatibility)
//!
//! | Key                    | Format                    | Value Type | Description |
//! |------------------------|---------------------------|------------|-------------|
//! | `privacy_enabled`      | `(Symbol, Address)`       | `bool`     | Legacy boolean privacy on/off key. Read as a fallback and migrated to [`DataKey::PrivacyEnabled`] on write. |
//!
//! ## Relations
//!
//! - **Escrow ↔ Commitment**: Each `Escrow(Bytes)` key is derived from a 32-byte commitment hash
//!   (`SHA256(owner || amount || salt)`). The stored [`EscrowEntry`] contains token, amount, owner,
//!   status, and created_at.
//! - **Admin ↔ Paused**: Admin can set the paused flag. Both are singleton keys.
//! - **PrivacyLevel ↔ PrivacyHistory**: Same account may have both; level is current, history is append-only.
//! - **PrivacyLevel / PrivacyHistory ↔ PrivacyEnabled**: Separate APIs; level-based vs boolean. Both persist per `Address`.
//!
//! ## Backwards Compatibility
//!
//! For future upgrades:
//! - **Do not** remove or change the discriminant of existing [`DataKey`] variants.
//! - **Add** new variants for new keys; they will not collide with existing ones.
//! - **Value layout**: Changing `EscrowEntry` fields may require migration logic; adding optional
//!   fields can be done carefully with defaults.
//! - **Lazy migration**: Reads still fall back to the legacy [`DataKey::Escrow`] payload.
//!   Any subsequent write rewrites the escrow into the compact layout and removes the
//!   legacy record.
//!
//! ## Input Validation Contract
//!
//! Storage writers in this module (e.g. [`put_escrow`], [`put_stealth_escrow`],
//! [`set_per_asset_fee`], [`set_platform_wallet`]) are **dumb persistence sinks**:
//! they do not re-validate addresses or asset identifiers. Validation of
//! contract addresses, asset identifiers, and their metadata is performed at the
//! entry boundary (the public contract methods in `lib.rs` and the validation
//! helpers in `crate::validation`) **before** any writer is invoked.
//!
//! Consequently:
//! - Malformed addresses / asset identifiers must be rejected at the boundary
//!   with a stable [`crate::errors::QuickexError`] variant.
//! - Invalid inputs **never reach these writers**, so no storage write occurs for
//!   them. Tests can assert this using [`assert_no_escrow_write`] and
//!   [`assert_no_per_asset_fee_write`] (see below), which verify that the
//!   relevant keys are absent after a rejected call.

use soroban_sdk::{contracttype, Address, Bytes, BytesN, Env, Map, Vec};

#[cfg(test)]
use soroban_sdk::xdr::ToXdr;

#[cfg(test)]
mod upgrade_safety_tests;

use crate::types::{
    CachedOraclePrice, DisputeVote, EscrowEntry, FeeConfig, Role, StealthEscrowEntry,
    TtlExtensionFeeConfig,
};

/// Record type for TTL policy selection.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RecordType {
    Escrow,
    EscrowDispute,
    FeeConfig,
    StealthEscrow,
    EscrowIdMap,
}

/// TTL policy configuration.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct TtlPolicy {
    /// Threshold in ledgers for TTL extension.
    pub threshold: u32,
    /// TTL in ledgers for this record type.
    pub ttl: u32,
}

/// Get TTL policy for a given record type.
fn get_ttl_policy(record_type: RecordType) -> TtlPolicy {
    match record_type {
        RecordType::Escrow => TtlPolicy {
            threshold: LEDGER_THRESHOLD,
            ttl: SIX_MONTHS_IN_LEDGERS,
        },
        RecordType::EscrowDispute => TtlPolicy {
            threshold: LEDGER_THRESHOLD,
            ttl: SIX_MONTHS_IN_LEDGERS,
        },
        RecordType::FeeConfig => TtlPolicy {
            threshold: LEDGER_THRESHOLD,
            ttl: SIX_MONTHS_IN_LEDGERS,
        },
        RecordType::StealthEscrow => TtlPolicy {
            threshold: LEDGER_THRESHOLD,
            ttl: SIX_MONTHS_IN_LEDGERS,
        },
        RecordType::EscrowIdMap => TtlPolicy {
            threshold: LEDGER_THRESHOLD,
            ttl: SIX_MONTHS_IN_LEDGERS,
        },
    }
}

// -----------------------------------------------------------------------------
// Key constants (for keys not using DataKey)
// -----------------------------------------------------------------------------

/// Symbol string for the legacy boolean privacy-enabled flag.
/// Used as `(Symbol::new(env, PRIVACY_ENABLED_KEY), Address)` in persistent storage.
/// See [`crate::privacy`] module for fallback/migration behaviour.
pub const PRIVACY_ENABLED_KEY: &str = "privacy_enabled";

pub const LEGACY_CONTRACT_VERSION: u32 = 0;
pub const CURRENT_CONTRACT_VERSION: u32 = 1;
pub const LEGACY_SCHEMA_VERSION: u32 = 0;
pub const SCHEMA_VERSION: u32 = 1;

pub const LEDGER_THRESHOLD: u32 = 17280; // ~1 day
pub const SIX_MONTHS_IN_LEDGERS: u32 = 3110400; // ~185 days

/// Bitmask flags for granular operation pausing.
#[contracttype]
#[repr(u64)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PauseFlag {
    Deposit = 1,
    Withdrawal = 2,
    Refund = 4,
    DepositWithCommitment = 8,
    SetPrivacy = 16,
    CreateAmountCommitment = 32,
}

// -----------------------------------------------------------------------------
// DataKey enum – central key derivation
// -----------------------------------------------------------------------------

/// Storage keys for the contract.
///
/// All persistent storage access should go through the helpers in this module.
/// Each variant maps to a distinct namespace; the Soroban runtime serialises
/// the enum discriminant and payload into the actual storage key.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Legacy escrow entry keyed by commitment hash (`Bytes`, typically 32 bytes).
    /// Kept for backward-compatible reads after the storage compaction pass.
    Escrow(Bytes),
    /// Compact escrow payload used for new and rewritten records.
    EscrowCore(Bytes),
    /// Optional dispute-only metadata for escrows that actually use arbiters.
    EscrowDispute(Bytes),
    /// Global escrow counter (singleton).
    EscrowCounter,
    /// TTL extension fee config (singleton).
    TtlExtensionFeeConfig,
    /// Current contract schema version (singleton).
    ContractVersion,
    /// Admin address (singleton).
    Admin,
    /// Explicit one-time initialization flag (singleton).
    Initialized,
    /// Paused state (singleton).
    Paused,
    /// Emergency mode (singleton, immutable once set true).
    EmergencyMode,
    /// Upgrade window start epoch (u64), in ledger timestamps. 0 = no window set.
    UpgradeWindowStart,
    /// Upgrade window end epoch (u64), in ledger timestamps. 0 = no upper bound.
    UpgradeWindowEnd,
    /// Flag indicating an upgrade is in progress (between start_upgrade and complete_upgrade).
    UpgradeInProgress,
    /// Numeric privacy level per account.
    PrivacyLevel(Address),
    /// Privacy level change history per account.
    PrivacyHistory(Address),
    /// Stealth escrow entry keyed by the 32-byte stealth address (Privacy v2).
    StealthEscrow(BytesN<32>),
    /// Granular operation pause bitmask (singleton).
    PauseFlags,
    /// Reason code for global pause.
    GlobalPauseReason,
    /// Reason codes for feature-specific pauses.
    FeaturePauseReasons,
    /// Fee configuration (singleton).
    FeeConfig,
    /// Platform wallet address for fee collection (singleton).
    PlatformWallet,
    /// Oracle fee configuration for dynamic USD-based fees.
    OracleFeeConfig,
    /// Cached oracle price with timestamp for staleness guards.
    CachedOraclePrice,
    /// Registered hook contract addresses.
    HookRegistry,
    /// Reentrancy guard to prevent callback-based reentry during hook execution.
    ReentrancyGuard,
    /// Boolean privacy flag per account.
    PrivacyEnabled(Address),
    /// 32-byte WASM hash stored at the last `upgrade()` call (singleton).
    WasmHash,
    /// Maps a deterministic 32-byte `escrow_id` (see [`crate::escrow_id`])
    /// to the commitment key of the escrow it identifies. Enables
    /// idempotent deduplication of identical creation requests.
    EscrowIdMap(BytesN<32>),
    /// Roles assigned to an address.
    UserRole(Address),
    /// Per-asset fee override keyed by token address (Fee Router v2).
    PerAssetFee(Address),
    /// Current active fee collector rotation index (Fee Router v2, singleton).
    FeeCollectorIndex,
    /// Fee collector address at a given rotation index (Fee Router v2).
    FeeCollector(u32),
    /// Timestamp of the last fee collector rotation for cooldown enforcement (singleton).
    FeeCollectorLastRotation,
    /// Rotation history entries (append-only Vec tracking all rotations).
    FeeCollectorRotationHistory,
    /// Tracks arbiter votes for disputed escrows. Keyed by (commitment, arbiter).
    DisputeVote(Bytes, Address),
    /// Tracks whether a hook contract is on the allowlist.
    HookAllowlist(Address),
    /// Escrow extension record tracking TTL renewals. Keyed by commitment.
    EscrowExtension(Bytes),
    /// Dispute evidence record. Keyed by (commitment, evidence_hash).
    DisputeEvidence(Bytes, BytesN<32>),
    /// Multi-signature admin signer set (singleton).
    AdminSigners,
    /// Number of required admin signatures (singleton).
    AdminThreshold,
    /// Current multi-signature approval round (singleton).
    AdminApprovalRound,
    /// Number of approvals in the current round (singleton).
    AdminApprovalCount,
    /// Whether the current approval round has reached quorum (singleton).
    AdminApprovalReady,
    /// Round in which an address last approved an admin action.
    AdminSignerApprovalRound(Address),
    /// Stored contract storage schema version (singleton).
    SchemaVersion,
}

/// Compact escrow record stored on the hot path.
///
/// Dispute metadata is intentionally split into a separate record so the common
/// no-arbiter escrow avoids paying storage rent for empty optional fields.
#[contracttype]
#[derive(Clone)]
struct CompactEscrowEntry {
    token: Address,
    amount_due: i128,
    amount_paid: i128,
    owner: Address,
    status: crate::types::EscrowStatus,
    created_at: u64,
    expires_at: u64,
}

impl CompactEscrowEntry {
    fn from_public(entry: &EscrowEntry) -> Self {
        Self {
            token: entry.token.clone(),
            amount_due: entry.amount_due,
            amount_paid: entry.amount_paid,
            owner: entry.owner.clone(),
            status: entry.status,
            created_at: entry.created_at,
            expires_at: entry.expires_at,
        }
    }

    fn into_public(self, env: &Env, dispute: EscrowDisputeConfig) -> EscrowEntry {
        EscrowEntry {
            token: self.token,
            amount_due: self.amount_due,
            amount_paid: self.amount_paid,
            owner: self.owner,
            status: self.status,
            created_at: self.created_at,
            expires_at: self.expires_at,
            arbiter: dispute.arbiter,
            arbiters: dispute.arbiters,
            arbiter_threshold: dispute.arbiter_threshold,
            memo: None,
            milestones: Vec::new(env),
        }
    }
}

/// Dispute-only escrow metadata stored separately from the hot-path core record.
#[contracttype]
#[derive(Clone)]
struct EscrowDisputeConfig {
    arbiter: Option<Address>,
    arbiters: Vec<Address>,
    arbiter_threshold: u32,
}

impl EscrowDisputeConfig {
    fn empty(env: &Env) -> Self {
        Self {
            arbiter: None,
            arbiters: Vec::new(env),
            arbiter_threshold: 0,
        }
    }

    fn from_public(env: &Env, entry: &EscrowEntry) -> Self {
        Self {
            arbiter: entry.arbiter.clone(),
            arbiters: if entry.arbiters.is_empty() {
                Vec::new(env)
            } else {
                entry.arbiters.clone()
            },
            arbiter_threshold: entry.arbiter_threshold,
        }
    }

    fn is_empty(&self) -> bool {
        self.arbiter.is_none() && self.arbiters.is_empty() && self.arbiter_threshold == 0
    }
}

fn legacy_escrow_key(commitment: &Bytes) -> DataKey {
    DataKey::Escrow(commitment.clone())
}

fn compact_escrow_key(commitment: &Bytes) -> DataKey {
    DataKey::EscrowCore(commitment.clone())
}

fn escrow_dispute_key(commitment: &Bytes) -> DataKey {
    DataKey::EscrowDispute(commitment.clone())
}

fn get_escrow_dispute_config(env: &Env, commitment: &Bytes) -> EscrowDisputeConfig {
    let key = escrow_dispute_key(commitment);
    let dispute = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| EscrowDisputeConfig::empty(env));

    if !dispute.is_empty() {
        set_or_extend_ttl(env, &key, RecordType::EscrowDispute);
    }

    dispute
}

fn put_escrow_dispute_config(env: &Env, commitment: &Bytes, entry: &EscrowEntry) {
    let key = escrow_dispute_key(commitment);
    let dispute = EscrowDisputeConfig::from_public(env, entry);

    if dispute.is_empty() {
        env.storage().persistent().remove(&key);
        return;
    }

    env.storage().persistent().set(&key, &dispute);
    set_or_extend_ttl(env, &key, RecordType::EscrowDispute);
}

fn extend_escrow_compaction_ttl(env: &Env, commitment: &Bytes) -> bool {
    let core_key = compact_escrow_key(commitment);
    if env.storage().persistent().has(&core_key) {
        set_or_extend_ttl(env, &core_key, RecordType::Escrow);

        let dispute_key = escrow_dispute_key(commitment);
        if env.storage().persistent().has(&dispute_key) {
            set_or_extend_ttl(env, &dispute_key, RecordType::EscrowDispute);
        }

        return true;
    }

    let legacy_key = legacy_escrow_key(commitment);
    if env.storage().persistent().has(&legacy_key) {
        set_or_extend_ttl(env, &legacy_key, RecordType::Escrow);
        return true;
    }

    false
}

// -----------------------------------------------------------------------------
// Emergency Mode helpers (module scope)
// -----------------------------------------------------------------------------
/// Set emergency mode. Once set to true, cannot be reverted.
pub fn set_emergency_mode(env: &Env) {
    let key = DataKey::EmergencyMode;
    let already_set: bool = env.storage().persistent().get(&key).unwrap_or(false);
    if !already_set {
        env.storage().persistent().set(&key, &true);
    }
    // If already set, do nothing (immutable)
}

/// Get emergency mode state.
pub fn is_emergency_mode(env: &Env) -> bool {
    let key = DataKey::EmergencyMode;
    env.storage().persistent().get(&key).unwrap_or(false)
}

// ─────────────────────────────────────────────────────────────────────────
// Upgrade Window helpers (Issue #432)
// ─────────────────────────────────────────────────────────────────────────

/// Set the upgrade window: [start, end] in ledger seconds (epoch).
/// - `start`: ledger timestamp when upgrades are allowed to begin. 0 = unset.
/// - `end`: ledger timestamp after which upgrades are blocked. 0 = no upper bound.
pub fn set_upgrade_window(env: &Env, start: u64, end: u64) -> Result<(), crate::errors::QuickexError> {
    if end != 0 && end <= start {
        return Err(crate::errors::QuickexError::InvalidAmount);
    }
    env.storage()
        .persistent()
        .set(&DataKey::UpgradeWindowStart, &start);
    env.storage()
        .persistent()
        .set(&DataKey::UpgradeWindowEnd, &end);
    Ok(())
}

/// Get the current upgrade window.
pub fn get_upgrade_window(env: &Env) -> (u64, u64) {
    let start = env
        .storage()
        .persistent()
        .get(&DataKey::UpgradeWindowStart)
        .unwrap_or(0u64);
    let end = env
        .storage()
        .persistent()
        .get(&DataKey::UpgradeWindowEnd)
        .unwrap_or(0u64);
    (start, end)
}

/// Check if upgrade window is currently active.
pub fn is_upgrade_window_active(env: &Env) -> bool {
    let (start, end) = get_upgrade_window(env);
    if start == 0 {
        return false; // No window set
    }
    let now = env.ledger().timestamp();
    now >= start && (end == 0 || now < end)
}

/// Set upgrade-in-progress flag.
pub fn set_upgrade_in_progress(env: &Env, in_progress: bool) {
    env.storage()
        .instance()
        .set(&DataKey::UpgradeInProgress, &in_progress);
    env.storage()
        .instance()
        .extend_ttl(LEDGER_THRESHOLD, SIX_MONTHS_IN_LEDGERS);
}

/// Get upgrade-in-progress flag.
pub fn is_upgrade_in_progress(env: &Env) -> bool {
    if let Some(in_progress) = env
        .storage()
        .instance()
        .get(&DataKey::UpgradeInProgress)
    {
        env.storage()
            .instance()
            .extend_ttl(LEDGER_THRESHOLD, SIX_MONTHS_IN_LEDGERS);
        return in_progress;
    }

    let legacy_in_progress = env
        .storage()
        .persistent()
        .get(&DataKey::UpgradeInProgress)
        .unwrap_or(false);
    if legacy_in_progress {
        set_upgrade_in_progress(env, true);
    }
    legacy_in_progress
}

pub fn get_governance_config(env: &Env) -> Option<GovernanceConfig> {
    if !governance_is_initialized(env) {
        return None;
    }
    env.storage()
        .instance()
        .extend_ttl(LEDGER_THRESHOLD, SIX_MONTHS_IN_LEDGERS);
    env.storage().instance().get(&DataKey::GovernanceConfig)
}

pub fn set_governance_config(env: &Env, config: &GovernanceConfig) {
    env.storage().instance().set(&DataKey::GovernanceConfig, config);
    env.storage().instance().set(&DataKey::GovernanceActivated, &true);
    env.storage()
        .instance()
        .extend_ttl(LEDGER_THRESHOLD, SIX_MONTHS_IN_LEDGERS);
}

pub fn governance_is_initialized(env: &Env) -> bool {
    let initialized = env.storage()
        .instance()
        .get(&DataKey::GovernanceActivated)
        .unwrap_or(false);
    if initialized {
        env.storage()
            .instance()
            .extend_ttl(LEDGER_THRESHOLD, SIX_MONTHS_IN_LEDGERS);
    }
    initialized
}

pub fn governance_execution_in_progress(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::GovernanceExecution)
        .unwrap_or(false)
}

pub fn set_governance_execution(env: &Env, executing: bool) {
    env.storage()
        .instance()
        .set(&DataKey::GovernanceExecution, &executing);
    env.storage()
        .instance()
        .extend_ttl(LEDGER_THRESHOLD, SIX_MONTHS_IN_LEDGERS);
}

pub fn get_governance_proposal(env: &Env, proposal_id: u64) -> Option<GovernanceProposal> {
    let key = DataKey::GovernanceProposal(proposal_id);
    let proposal = env.storage().persistent().get(&key);
    if proposal.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, LEDGER_THRESHOLD, SIX_MONTHS_IN_LEDGERS);
    }
    proposal
}

pub fn set_governance_proposal(env: &Env, proposal_id: u64, proposal: &GovernanceProposal) {
    let key = DataKey::GovernanceProposal(proposal_id);
    env.storage().persistent().set(&key, proposal);
    env.storage()
        .persistent()
        .extend_ttl(&key, LEDGER_THRESHOLD, SIX_MONTHS_IN_LEDGERS);
}

pub fn next_governance_proposal_id(env: &Env) -> Option<u64> {
    let current: u64 = env
        .storage()
        .instance()
        .get(&DataKey::GovernanceProposalCounter)
        .unwrap_or(0);
    let next = current.checked_add(1)?;
    env.storage().instance().set(&DataKey::GovernanceProposalCounter, &next);
    env.storage()
        .instance()
        .extend_ttl(LEDGER_THRESHOLD, SIX_MONTHS_IN_LEDGERS);
    Some(next)
}

pub fn set_pending_upgrade_version(env: &Env, version: u32) {
    env.storage()
        .instance()
        .set(&DataKey::PendingUpgradeVersion, &version);
    env.storage()
        .instance()
        .extend_ttl(LEDGER_THRESHOLD, SIX_MONTHS_IN_LEDGERS);
}

pub fn get_pending_upgrade_version(env: &Env) -> Option<u32> {
    let version = env
        .storage()
        .instance()
        .get(&DataKey::PendingUpgradeVersion);
    if version.is_some() {
        env.storage()
            .instance()
            .extend_ttl(LEDGER_THRESHOLD, SIX_MONTHS_IN_LEDGERS);
    }
    version
}

pub fn clear_pending_upgrade_version(env: &Env) {
    env.storage()
        .instance()
        .remove(&DataKey::PendingUpgradeVersion);
}

// ─────────────────────────────────────────────────────────────────────────
// Invariant Checking (Issue #432)
// ─────────────────────────────────────────────────────────────────────────

/// Assert critical post-upgrade invariants.
///
/// Called after migration to validate state machine and fee bounds.
/// Returns `Ok(())` if all invariants hold; `Err(msg)` deterministically if violated.
pub fn assert_post_upgrade_invariants(env: &Env) -> Result<(), &'static str> {
    // Invariant 1: Fee bounds must be within [0, MAX_FEE_BPS] basis points.
    let fee_cfg = get_fee_config(env);
    if fee_cfg.fee_bps > crate::fee::MAX_FEE_BPS {
        return Err("fee_bps exceeds maximum (10000)");
    }

    // Invariant 2: Contract and schema version must be set to CURRENT / SCHEMA_VERSION.
    let version = get_contract_version(env);
    if version != Some(CURRENT_CONTRACT_VERSION) {
        return Err("contract version not set to current after migration");
    }
    let schema_version = get_schema_version(env);
    if schema_version != Some(SCHEMA_VERSION) {
        return Err("schema version not set to current after migration");
    }

    // Invariant 3: Admin must be initialized.
    if get_admin(env).is_none() {
        return Err("admin not initialized post-upgrade");
    }

    // Invariant 4: Escrow counter must remain non-negative (always true for u64).
    let _counter = get_escrow_counter(env);
    // Counter is u64, so this is always valid.

    // Invariant 5: Per-asset fee bounds (if any exist).
    // Note: We cannot iterate all per-asset fees here without a registry.
    // This is validated per-write in set_per_asset_fee.

    Ok(())
}

// -----------------------------------------------------------------------------
// Escrow helpers
// -----------------------------------------------------------------------------

/// Put an escrow entry into storage.
///
/// **Contract**: Overwrites any existing entry for the same commitment.
/// The commitment should be the 32-byte `SHA256(owner || amount || salt)` hash.
///
/// **Validation**: This writer performs no address/asset validation. Callers
/// MUST validate `entry.token`, `entry.owner`, and any arbiter addresses at the
/// entry boundary before invoking this function. Invalid inputs never reach
/// this writer, so no storage write occurs for them.
pub fn put_escrow(env: &Env, commitment: &Bytes, entry: &EscrowEntry) {
    let compact_key = compact_escrow_key(commitment);
    let compact_entry = CompactEscrowEntry::from_public(entry);

    env.storage().persistent().set(&compact_key, &compact_entry);
    set_or_extend_ttl(env, &compact_key, RecordType::Escrow);
    put_escrow_dispute_config(env, commitment, entry);

    // Lazy migration: once an escrow is rewritten, retire the legacy payload.
    env.storage()
        .persistent()
        .remove(&legacy_escrow_key(commitment));
}

/// Remove an escrow entry from storage and reclaim the storage deposit.
pub fn remove_escrow(env: &Env, commitment: &Bytes) {
    env.storage()
        .persistent()
        .remove(&compact_escrow_key(commitment));
    env.storage()
        .persistent()
        .remove(&escrow_dispute_key(commitment));
    env.storage()
        .persistent()
        .remove(&legacy_escrow_key(commitment));
}

/// Get an escrow entry from storage.
///
/// **Contract**: Returns `None` if no escrow exists for the commitment.
pub fn get_escrow(env: &Env, commitment: &Bytes) -> Option<EscrowEntry> {
    let compact_key = compact_escrow_key(commitment);
    let compact_result: Option<CompactEscrowEntry> = env.storage().persistent().get(&compact_key);
    if let Some(compact_entry) = compact_result {
        set_or_extend_ttl(env, &compact_key, RecordType::Escrow);
        let dispute = get_escrow_dispute_config(env, commitment);
        return Some(compact_entry.into_public(env, dispute));
    }

    let legacy_key = legacy_escrow_key(commitment);
    let legacy_result: Option<EscrowEntry> = env.storage().persistent().get(&legacy_key);
    if legacy_result.is_some() {
        set_or_extend_ttl(env, &legacy_key, RecordType::Escrow);
    }
    legacy_result
}

/// Check if an escrow entry exists in storage.
#[allow(dead_code)]
pub fn has_escrow(env: &Env, commitment: &Bytes) -> bool {
    env.storage()
        .persistent()
        .has(&compact_escrow_key(commitment))
        || env
            .storage()
            .persistent()
            .has(&legacy_escrow_key(commitment))
}

/// Migrate a legacy `DataKey::Escrow(commitment)` record to the compact v1
/// schema (`DataKey::EscrowCore` + optional `DataKey::EscrowDispute`).
///
/// Idempotent: returns `true` when a legacy record was transformed, or `false`
/// if the record was already migrated or does not exist.
pub fn migrate_legacy_escrow_record(env: &Env, commitment: &Bytes) -> bool {
    let legacy_key = legacy_escrow_key(commitment);
    let legacy_entry: Option<EscrowEntry> = env.storage().persistent().get(&legacy_key);
    if let Some(entry) = legacy_entry {
        put_escrow(env, commitment, &entry);
        return true;
    }
    false
}

/// Extend the TTL of whichever escrow representation is currently stored.
pub fn extend_escrow_storage_ttl(env: &Env, commitment: &Bytes) -> bool {
    extend_escrow_compaction_ttl(env, commitment)
}

#[cfg(test)]
pub(crate) fn legacy_escrow_storage_footprint_bytes(
    env: &Env,
    commitment: &Bytes,
    entry: &EscrowEntry,
) -> usize {
    (legacy_escrow_key(commitment).to_xdr(env).len() + entry.to_xdr(env).len()) as usize
}

#[cfg(test)]
pub(crate) fn compact_escrow_storage_footprint_bytes(
    env: &Env,
    commitment: &Bytes,
    entry: &EscrowEntry,
) -> usize {
    let compact_key = compact_escrow_key(commitment);
    let compact_entry = CompactEscrowEntry::from_public(entry);
    let mut total = compact_key.to_xdr(env).len() + compact_entry.to_xdr(env).len();

    let dispute = EscrowDisputeConfig::from_public(env, entry);
    if !dispute.is_empty() {
        total += escrow_dispute_key(commitment).to_xdr(env).len() + dispute.to_xdr(env).len();
    }

    total as usize
}

// -----------------------------------------------------------------------------
// Test-only storage assertions (Issue #624)
// -----------------------------------------------------------------------------
//
// These helpers let negative tests verify that malformed address / asset
// inputs are rejected at the entry boundary *before* any storage write occurs.
// They are compiled only under `#[cfg(test)]` and never affect production code.

/// Assert that no escrow record (compact, dispute, or legacy) exists for
/// `commitment`. Used by negative tests to confirm that a rejected create
/// request did not persist anything.
#[cfg(test)]
pub(crate) fn assert_no_escrow_write(env: &Env, commitment: &Bytes) {
    assert!(
        !env.storage()
            .persistent()
            .has(&compact_escrow_key(commitment)),
        "unexpected EscrowCore write for rejected input"
    );
    assert!(
        !env.storage()
            .persistent()
            .has(&escrow_dispute_key(commitment)),
        "unexpected EscrowDispute write for rejected input"
    );
    assert!(
        !env.storage()
            .persistent()
            .has(&legacy_escrow_key(commitment)),
        "unexpected legacy Escrow write for rejected input"
    );
}

/// Assert that no per-asset fee override exists for `token`. Used by negative
/// tests to confirm that a malformed asset identifier was rejected before the
/// fee router persisted anything.
#[cfg(test)]
pub(crate) fn assert_no_per_asset_fee_write(env: &Env, token: &Address) {
    assert!(
        !env.storage()
            .persistent()
            .has(&DataKey::PerAssetFee(token.clone())),
        "unexpected PerAssetFee write for rejected asset input"
    );
}

/// Assert that no stealth escrow record exists for `stealth_address`.
#[cfg(test)]
pub(crate) fn assert_no_stealth_escrow_write(env: &Env, stealth_address: &BytesN<32>) {
    assert!(
        !env.storage()
            .persistent()
            .has(&DataKey::StealthEscrow(stealth_address.clone())),
        "unexpected StealthEscrow write for rejected input"
    );
}

/// Get the next escrow counter value.
///
/// **Contract**: Returns 0 if never set. Counter is used for `create_escrow`.
#[allow(dead_code)]
pub fn get_escrow_counter(env: &Env) -> u64 {
    let key = DataKey::EscrowCounter;
    env.storage().persistent().get(&key).unwrap_or(0)
}

/// Increment and return the escrow counter.
///
/// **Contract**: Atomic increment. Initial value treated as 0.
pub fn increment_escrow_counter(env: &Env) -> u64 {
    let key = DataKey::EscrowCounter;
    let mut count: u64 = env.storage().persistent().get(&key).unwrap_or(0);
    count += 1;
    env.storage().persistent().set(&key, &count);
    count
}

pub fn get_contract_version(env: &Env) -> Option<u32> {
    env.storage()
        .persistent()
        .get(&DataKey::ContractVersion)
        .or_else(|| env.storage().persistent().get(&DataKey::SchemaVersion))
}

pub fn set_contract_version(env: &Env, version: u32) {
    env.storage()
        .persistent()
        .set(&DataKey::ContractVersion, &version);
    env.storage()
        .persistent()
        .set(&DataKey::SchemaVersion, &version);
}

/// Validate that a proposed schema version is a legal upgrade step.
///
/// The upgrade safety gate only permits a single-step forward migration:
/// the target version must be exactly `current + 1`. Downgrades, no-op
/// re-applications, and multi-step jumps are rejected so that every
/// intermediate migration is rehearsed and applied in order.
///
/// Returns `Ok(())` when the transition is allowed, or a deterministic
/// error string describing the violated boundary.
pub fn validate_schema_version_transition(
    current: Option<u32>,
    target: u32,
) -> Result<(), &'static str> {
    let current = current.unwrap_or(LEGACY_SCHEMA_VERSION);
    if target <= current {
        return Err("schema version must increase by exactly one (downgrade or no-op rejected)");
    }
    if target != current + 1 {
        return Err("schema version jump rejected: only single-step upgrades are allowed");
    }
    Ok(())
}

/// Apply a schema version transition through the upgrade safety gate.
///
/// Reads the stored schema version, validates the transition with
/// [`validate_schema_version_transition`], and only then persists the new
/// version. On rejection the stored version is left untouched so a failed
/// rehearsal cannot corrupt on-chain metadata.
pub fn apply_schema_version_upgrade(env: &Env, target: u32) -> Result<(), &'static str> {
    let current = get_schema_version(env);
    validate_schema_version_transition(current, target)?;
    set_schema_version(env, target);
    Ok(())
}

pub fn get_schema_version(env: &Env) -> Option<u32> {
    env.storage()
        .persistent()
        .get(&DataKey::SchemaVersion)
        .or_else(|| env.storage().persistent().get(&DataKey::ContractVersion))
}

pub fn set_schema_version(env: &Env, version: u32) {
    env.storage()
        .persistent()
        .set(&DataKey::SchemaVersion, &version);
    env.storage()
        .persistent()
        .set(&DataKey::ContractVersion, &version);
}
