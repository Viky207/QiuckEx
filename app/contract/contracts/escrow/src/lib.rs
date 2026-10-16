#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Symbol};

/// Storage key for an individual escrow entry.
#[contracttype]
#[derive(Clone)]
pub struct EscrowKey {
    pub escrow_id: u64,
}

/// A single escrow entry tracked by the contract.
#[contracttype]
#[derive(Clone)]
pub struct Escrow {
    pub sender: Address,
    pub recipient: Address,
    pub amount: i128,
    pub condition_hash: BytesN<32>,
    /// Ledger sequence at which this escrow expires and becomes refundable.
    pub expiry_ledger: u32,
    pub released: bool,
    pub refunded: bool,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum EscrowError {
    EscrowNotFound = 1,
    EscrowAlreadySettled = 2,
    NotYetExpired = 3,
    AlreadyExpired = 4,
    Unauthorized = 5,
    InvalidAmount = 6,
    InvalidTtl = 7,
}

const ESCROW: Symbol = symbol_short!("ESCROW");
const ESCROW_EXPIRED: Symbol = symbol_short!("EscrowExpired");

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Create a new escrow entry. The creator specifies the time-lock window
    /// in ledgers via `ttl_ledgers`; the escrow becomes refundable once the
    /// current ledger passes `expiry_ledger`.
    pub fn create_escrow(
        env: Env,
        escrow_id: u64,
        sender: Address,
        recipient: Address,
        amount: i128,
        condition_hash: BytesN<32>,
        ttl_ledgers: u32,
    ) -> Result<(), EscrowError> {
        sender.require_auth();

        if amount <= 0 {
            return Err(EscrowError::InvalidAmount);
        }
        if ttl_ledgers == 0 {
            return Err(EscrowError::InvalidTtl);
        }

        let key = EscrowKey { escrow_id };
        if env.storage().persistent().has(&key) {
            return Err(EscrowError::EscrowAlreadySettled);
        }

        let expiry_ledger = env.ledger().sequence().saturating_add(ttl_ledgers);

        let escrow = Escrow {
            sender,
            recipient,
            amount,
            condition_hash,
            expiry_ledger,
            released: false,
            refunded: false,
        };

        env.storage().persistent().set(&key, &escrow);
        Ok(())
    }

    /// Release the escrowed funds to the recipient. Callable by the recipient
    /// only, and only before the escrow has expired.
    pub fn release_escrow(
        env: Env,
        escrow_id: u64,
        proof: BytesN<32>,
    ) -> Result<(), EscrowError> {
        let key = EscrowKey { escrow_id };
        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::EscrowNotFound)?;

        if escrow.released || escrow.refunded {
            return Err(EscrowError::EscrowAlreadySettled);
        }

        escrow.recipient.require_auth();

        if env.ledger().sequence() >= escrow.expiry_ledger {
            return Err(EscrowError::AlreadyExpired);
        }

        if proof != escrow.condition_hash {
            return Err(EscrowError::Unauthorized);
        }

        escrow.released = true;
        env.storage().persistent().set(&key, &escrow);
        Ok(())
    }

    /// Refund the escrowed funds to the original sender. Callable by the
    /// sender only, and only after the escrow has expired.
    pub fn refund_escrow(env: Env, escrow_id: u64) -> Result<(), EscrowError> {
        let key = EscrowKey { escrow_id };
        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::EscrowNotFound)?;

        if escrow.released || escrow.refunded {
            return Err(EscrowError::EscrowAlreadySettled);
        }

        escrow.sender.require_auth();

        if env.ledger().sequence() < escrow.expiry_ledger {
            return Err(EscrowError::NotYetExpired);
        }

        escrow.refunded = true;
        env.storage().persistent().set(&key, &escrow);

        env.events().publish(
            (ESCROW_EXPIRED, escrow_id),
            (escrow.sender.clone(), escrow.recipient.clone(), escrow.amount),
        );

        Ok(())
    }

    /// Read an escrow entry. Returns `None` if it does not exist.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Option<Escrow> {
        let key = EscrowKey { escrow_id };
        env.storage().persistent().get(&key)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, testutils::Ledger, BytesN, Env};

    fn setup() -> (Env, EscrowContractClient<'static>, Address, Address, BytesN<32>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let condition_hash = BytesN::from_array(&env, &[7u8; 32]);
        (env, client, sender, recipient, condition_hash)
    }

    #[test]
    fn refund_before_ttl_fails() {
        let (env, client, sender, recipient, condition_hash) = setup();
        client.create_escrow(&1, &sender, &recipient, &100, &condition_hash, &48);

        // Still within the time-lock window.
        env.ledger().set_sequence_number(10);
        let result = client.try_refund_escrow(&1);
        assert_eq!(result, Err(Ok(EscrowError::NotYetExpired)));
    }

    #[test]
    fn refund_after_ttl_succeeds() {
        let (env, client, sender, recipient, condition_hash) = setup();
        client.create_escrow(&1, &sender, &recipient, &100, &condition_hash, &48);

        // Advance past the expiry ledger.
        env.ledger().set_sequence_number(100);
        client.refund_escrow(&1);

        let escrow = client.get_escrow(&1).unwrap();
        assert!(escrow.refunded);
        assert!(!escrow.released);
    }

    #[test]
    fn release_before_expiry_succeeds() {
        let (env, client, sender, recipient, condition_hash) = setup();
        client.create_escrow(&1, &sender, &recipient, &100, &condition_hash, &48);

        env.ledger().set_sequence_number(10);
        client.release_escrow(&1, &condition_hash);

        let escrow = client.get_escrow(&1).unwrap();
        assert!(escrow.released);
        assert!(!escrow.refunded);
    }

    #[test]
    fn release_after_expiry_fails() {
        let (env, client, sender, recipient, condition_hash) = setup();
        client.create_escrow(&1, &sender, &recipient, &100, &condition_hash, &48);

        env.ledger().set_sequence_number(100);
        let result = client.try_release_escrow(&1, &condition_hash);
        assert_eq!(result, Err(Ok(EscrowError::AlreadyExpired)));
    }
}
