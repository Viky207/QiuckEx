use soroban_sdk::contracterror;

/// Canonical contract error codes.
///
/// Code bands:
/// - 100-199: validation failures
/// - 200-299: auth/admin failures
/// - 300-399: state, escrow, and commitment violations
/// - 900-999: internal/unexpected conditions
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum QuickexError {
    // Validation failures (100-199)
    InvalidAmount = 100,
    InvalidSalt = 101,
    InvalidPrivacyLevel = 102,
    /// An intermediate or final arithmetic result overflowed the supported range.
    /// No wrapped value is stored or emitted; the operation is rejected.
    Overflow = 103,
    /// A contract address is malformed (wrong length, wrong network, or wrong
    /// account type) and failed validation before any storage write.
    InvalidContractAddress = 104,
    /// An asset identifier is malformed or its metadata is unsupported.
    InvalidAsset = 105,
    // Auth/admin failures (200-299)
    Unauthorized = 200,
    AlreadyInitialized = 201,
    InsufficientRole = 202,
    /// Caller is not an active governance signer.
    NotGovernanceSigner = 203,
    /// The configured signer set or threshold is invalid.
    InvalidGovernanceConfig = 204,
    /// Governance has already been initialized.
    GovernanceAlreadyInitialized = 205,
    /// A multisig governance proposal is required for this privileged operation.
    GovernanceRequired = 206,
    // State, escrow, and commitment violations (300-399)
    ContractPaused = 300,
    PrivacyAlreadySet = 301,
    CommitmentNotFound = 302,
    CommitmentAlreadyExists = 303,
    AlreadySpent = 304,
    InvalidCommitment = 305,
    CommitmentMismatch = 306,
    /// Escrow has passed its expiry; withdrawal is no longer possible.
    EscrowExpired = 307,
    /// Escrow has not yet expired; refund is not yet available.
    EscrowNotExpired = 308,
    /// Caller is not the original owner of the escrow.
    InvalidOwner = 309,
    /// No arbiter assigned to the escrow; dispute cannot be raised.
    NoArbiter = 310,
    /// Escrow is not in the required state for this operation.
    InvalidDisputeState = 311,
    /// Caller is not the assigned arbiter.
    NotArbiter = 312,
    /// The requested operation is paused via granular pause flags.
    OperationPaused = 313,
    /// The stored contract version cannot be migrated by this release.
    InvalidContractVersion = 314,
    /// Payment amount exceeds the remaining amount due for the escrow.
    Overpayment = 315,
    /// Reentrant callback detected during hook invocation.
    ReentrancyDetected = 316,
    /// Hook contract is already registered.
    HookAlreadyRegistered = 317,
    /// Hook contract was not registered.
    HookNotRegistered = 318,
    /// Caller is not one of the assigned multi-sig arbiters.
    NotAnArbiter = 319,
    /// Arbiter has already voted on this dispute.
    ArbiterAlreadyVoted = 320,
    /// Insufficient arbiter votes to reach the threshold for resolution.
    InsufficientVotes = 321,
    /// This signer has already approved the current admin action round.
    AdminActionAlreadyApproved = 327,
    /// Hook contract is not allowed.
    HookNotAllowed = 322,
    /// Maximum number of escrow extensions reached.
    MaxExtensionsReached = 323,
    /// Escrow extension would exceed maximum lifetime.
    ExtensionExceedsMaxLifetime = 324,
    /// Evidence hash is invalid or missing.
    InvalidEvidenceHash = 325,
    /// Evidence size exceeds maximum allowed.
    EvidenceSizeExceeded = 326,
    // Stealth address errors (400-499)
    /// Derived stealth address does not match the provided one.
    StealthAddressMismatch = 400,
    /// A stealth escrow already exists for this stealth address.
    StealthAddressAlreadyUsed = 401,
    /// No stealth escrow found for the given stealth address.
    StealthEscrowNotFound = 402,
    // Key rotation lifecycle errors (400-499)
    /// A key rotation has been announced and is pending activation.
    KeyRotationAnnounced = 403,
    /// The grace period for the previous key is still active.
    KeyRotationGraceActive = 404,
    /// The announced key rotation has been revoked.
    KeyRotationRevoked = 405,
    /// The rotation proof or nonce has already been consumed; replay detected.
    KeyRotationReplay = 406,
    /// No key rotation found for the given identifier.
    KeyRotationNotFound = 407,
    /// The key rotation window has expired.
    KeyRotationExpired = 408,
    // Oracle errors (600-699)
    /// Oracle price data exceeds the configured staleness threshold and was rejected.
    OracleStalePrice = 600,
    /// No oracle price has been cached yet; dynamic fee cannot be computed.
    OraclePriceUnavailable = 601,
    /// The cached oracle price is zero or negative, which is invalid.
    OraclePriceInvalid = 602,
    // Internal/unexpected conditions (900-999)
    InternalError = 900,
    InvalidTimeout = 901,
    // Replay protection (500-599)
    /// The (signer, nonce) pair has already been consumed; replay detected.
    NonceAlreadyUsed = 500,
    /// The signature's valid_until timestamp has passed; signature expired.
    SignatureExpired = 501,
}

#[cfg(test)]
mod compatibility_tests {
    use super::QuickexError;

    #[test]
    fn existing_error_codes_remain_stable() {
        let existing_codes = [
            (QuickexError::InvalidAmount, 100),
            (QuickexError::InvalidSalt, 101),
            (QuickexError::InvalidPrivacyLevel, 102),
            (QuickexError::Overflow, 103),
            (QuickexError::InvalidContractAddress, 104),
            (QuickexError::InvalidAsset, 105),
            (QuickexError::Unauthorized, 200),
            (QuickexError::AlreadyInitialized, 201),
            (QuickexError::InsufficientRole, 202),
            (QuickexError::ContractPaused, 300),
            (QuickexError::PrivacyAlreadySet, 301),
            (QuickexError::CommitmentNotFound, 302),
            (QuickexError::CommitmentAlreadyExists, 303),
            (QuickexError::AlreadySpent, 304),
            (QuickexError::InvalidCommitment, 305),
            (QuickexError::CommitmentMismatch, 306),
            (QuickexError::EscrowExpired, 307),
            (QuickexError::EscrowNotExpired, 308),
            (QuickexError::InvalidOwner, 309),
            (QuickexError::NoArbiter, 310),
            (QuickexError::InvalidDisputeState, 311),
            (QuickexError::NotArbiter, 312),
            (QuickexError::OperationPaused, 313),
            (QuickexError::InvalidContractVersion, 314),
            (QuickexError::Overpayment, 315),
            (QuickexError::ReentrancyDetected, 316),
            (QuickexError::HookAlreadyRegistered, 317),
            (QuickexError::HookNotRegistered, 318),
            (QuickexError::NotAnArbiter, 319),
            (QuickexError::ArbiterAlreadyVoted, 320),
            (QuickexError::InsufficientVotes, 321),
            (QuickexError::HookNotAllowed, 322),
            (QuickexError::StealthAddressMismatch, 400),
            (QuickexError::StealthAddressAlreadyUsed, 401),
            (QuickexError::StealthEscrowNotFound, 402),
            (QuickexError::KeyRotationAnnounced, 403),
            (QuickexError::KeyRotationGraceActive, 404),
            (QuickexError::KeyRotationRevoked, 405),
            (QuickexError::KeyRotationReplay, 406),
            (QuickexError::KeyRotationNotFound, 407),
            (QuickexError::KeyRotationExpired, 408),
            (QuickexError::NonceAlreadyUsed, 500),
            (QuickexError::SignatureExpired, 501),
            (QuickexError::OracleStalePrice, 600),
            (QuickexError::OraclePriceUnavailable, 601),
            (QuickexError::OraclePriceInvalid, 602),
            (QuickexError::InternalError, 900),
            (QuickexError::InvalidTimeout, 901),
        ];

        for (error, expected_code) in existing_codes {
            assert_eq!(error as u32, expected_code);
        }
    }

    #[test]
    fn new_governance_errors_use_additive_codes() {
        let new_codes = [
            (QuickexError::NotGovernanceSigner, 203),
            (QuickexError::InvalidGovernanceConfig, 204),
            (QuickexError::GovernanceAlreadyInitialized, 205),
            (QuickexError::GovernanceRequired, 206),
            (QuickexError::InvalidUpgradeWindow, 323),
            (QuickexError::UpgradeAlreadyInProgress, 324),
            (QuickexError::UpgradeNotInProgress, 325),
            (QuickexError::TimelockNotElapsed, 326),
            (QuickexError::ProposalNotFound, 327),
            (QuickexError::ProposalAlreadyApproved, 328),
            (QuickexError::ProposalAlreadyExecuted, 329),
            (QuickexError::ProposalCanceled, 330),
            (QuickexError::InsufficientApprovals, 331),
            (QuickexError::InvalidProposal, 332),
        ];

        for (index, (error, expected_code)) in new_codes.iter().enumerate() {
            assert_eq!(*error as u32, *expected_code);
            for (other, _) in new_codes.iter().skip(index + 1) {
                assert_ne!(error, other);
            }
        }
    }

    #[test]
    fn validation_errors_use_additive_codes() {
        let new_codes = [
            (QuickexError::Overflow, 103),
            (QuickexError::InvalidContractAddress, 104),
            (QuickexError::InvalidAsset, 105),
        ];

        for (index, (error, expected_code)) in new_codes.iter().enumerate() {
            assert_eq!(*error as u32, *expected_code);
            for (other, _) in new_codes.iter().skip(index + 1) {
                assert_ne!(error, other);
            }
        }
    }

    #[test]
    fn all_error_codes_are_unique() {
        let all_codes = [
            (QuickexError::InvalidAmount, 100),
            (QuickexError::InvalidSalt, 101),
            (QuickexError::InvalidPrivacyLevel, 102),
            (QuickexError::Overflow, 103),
            (QuickexError::InvalidContractAddress, 104),
            (QuickexError::InvalidAsset, 105),
            (QuickexError::Unauthorized, 200),
            (QuickexError::AlreadyInitialized, 201),
            (QuickexError::InsufficientRole, 202),
            (QuickexError::NotGovernanceSigner, 203),
            (QuickexError::InvalidGovernanceConfig, 204),
            (QuickexError::GovernanceAlreadyInitialized, 205),
            (QuickexError::GovernanceRequired, 206),
            (QuickexError::ContractPaused, 300),
            (QuickexError::PrivacyAlreadySet, 301),
            (QuickexError::CommitmentNotFound, 302),
            (QuickexError::CommitmentAlreadyExists, 303),
            (QuickexError::AlreadySpent, 304),
            (QuickexError::InvalidCommitment, 305),
            (QuickexError::CommitmentMismatch, 306),
            (QuickexError::EscrowExpired, 307),
            (QuickexError::EscrowNotExpired, 308),
            (QuickexError::InvalidOwner, 309),
            (QuickexError::NoArbiter, 310),
            (QuickexError::InvalidDisputeState, 311),
            (QuickexError::NotArbiter, 312),
            (QuickexError::OperationPaused, 313),
            (QuickexError::InvalidContractVersion, 314),
            (QuickexError::Overpayment, 315),
            (QuickexError::ReentrancyDetected, 316),
            (QuickexError::HookAlreadyRegistered, 317),
            (QuickexError::HookNotRegistered, 318),
            (QuickexError::NotAnArbiter, 319),
            (QuickexError::ArbiterAlreadyVoted, 320),
            (QuickexError::InsufficientVotes, 321),
            (QuickexError::HookNotAllowed, 322),
            (QuickexError::MaxExtensionsReached, 323),
            (QuickexError::ExtensionExceedsMaxLifetime, 324),
            (QuickexError::InvalidEvidenceHash, 325),
            (QuickexError::EvidenceSizeExceeded, 326),
            (QuickexError::AdminActionAlreadyApproved, 327),
            (QuickexError::StealthAddressMismatch, 400),
            (QuickexError::StealthAddressAlreadyUsed, 401),
            (QuickexError::StealthEscrowNotFound, 402),
            (QuickexError::KeyRotationAnnounced, 403),
            (QuickexError::KeyRotationGraceActive, 404),
            (QuickexError::KeyRotationRevoked, 405),
            (QuickexError::KeyRotationReplay, 406),
            (QuickexError::KeyRotationNotFound, 407),
            (QuickexError::KeyRotationExpired, 408),
            (QuickexError::NonceAlreadyUsed, 500),
            (QuickexError::SignatureExpired, 501),
            (QuickexError::OracleStalePrice, 600),
            (QuickexError::OraclePriceUnavailable, 601),
            (QuickexError::OraclePriceInvalid, 602),
            (QuickexError::InternalError, 900),
            (QuickexError::InvalidTimeout, 901),
        ];

        for (index, (error, expected_code)) in all_codes.iter().enumerate() {
            assert_eq!(*error as u32, *expected_code);
            for (other, other_code) in all_codes.iter().skip(index + 1) {
                assert_ne!(error, other);
                assert_ne!(expected_code, other_code);
            }
        }
    }
}
