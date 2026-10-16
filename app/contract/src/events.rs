//! Structured contract events for all state transitions.
//!
//! Every state-mutating entry point in the escrow contract publishes a single
//! event with a consistent schema so that off-chain consumers (Horizon's
//! `/events` stream) can react without polling:
//!
//! ```text
//! { event_type: Symbol, escrow_id: u64, actor: Address, ledger: u32 }
//! ```
//!
//! Payloads are intentionally minimal (well under Soroban's 8KB limit) and
//! never contain sensitive data such as private amounts in X-Ray mode.

use soroban_sdk::{Address, Env, Symbol};

/// Canonical event type symbols. Kept as constants so the contract and its
/// tests share a single source of truth for the emitted schema.
pub const ESCROW_CREATED: &str = "escrow_created";
pub const ESCROW_RELEASED: &str = "escrow_released";
pub const ESCROW_REFUNDED: &str = "escrow_refunded";
pub const ESCROW_EXPIRED: &str = "escrow_expired";
pub const CONTRACT_PAUSED: &str = "contract_paused";
pub const CONTRACT_UPGRADED: &str = "contract_upgraded";

/// Publish a structured state-transition event.
///
/// The event topics carry the `event_type` symbol (so subscribers can filter
/// by topic) and the data payload carries the remaining schema fields.
fn emit(env: &Env, event_type: &str, escrow_id: u64, actor: &Address, ledger: u32) {
    let topics = (Symbol::new(env, event_type),);
    env.events().publish(topics, (escrow_id, actor.clone(), ledger));
}

/// Emitted when a new escrow is created.
pub fn escrow_created(env: &Env, escrow_id: u64, actor: &Address) {
    emit(env, ESCROW_CREATED, escrow_id, actor, env.ledger().sequence());
}

/// Emitted when an escrow's funds are released to the beneficiary.
pub fn escrow_released(env: &Env, escrow_id: u64, actor: &Address) {
    emit(env, ESCROW_RELEASED, escrow_id, actor, env.ledger().sequence());
}

/// Emitted when an escrow is refunded to the depositor.
pub fn escrow_refunded(env: &Env, escrow_id: u64, actor: &Address) {
    emit(env, ESCROW_REFUNDED, escrow_id, actor, env.ledger().sequence());
}

/// Emitted when an escrow expires without being released or refunded.
pub fn escrow_expired(env: &Env, escrow_id: u64, actor: &Address) {
    emit(env, ESCROW_EXPIRED, escrow_id, actor, env.ledger().sequence());
}

/// Emitted when the contract is paused by an admin.
pub fn contract_paused(env: &Env, actor: &Address) {
    emit(env, CONTRACT_PAUSED, 0, actor, env.ledger().sequence());
}

/// Emitted when the contract is upgraded to a new WASM hash.
pub fn contract_upgraded(env: &Env, actor: &Address) {
    emit(env, CONTRACT_UPGRADED, 0, actor, env.ledger().sequence());
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Events, Env};

    fn assert_event(env: &Env, event_type: &str, escrow_id: u64, actor: &Address) {
        let expected = Symbol::new(env, event_type);
        let events = env.events().all();
        let last = events.last().expect("expected an event to be emitted");
        assert_eq!(last.0, expected);
        assert_eq!(last.1, (escrow_id, actor.clone(), env.ledger().sequence()));
    }

    #[test]
    fn emits_escrow_created() {
        let env = Env::default();
        let actor = Address::generate(&env);
        escrow_created(&env, 1, &actor);
        assert_event(&env, ESCROW_CREATED, 1, &actor);
    }

    #[test]
    fn emits_escrow_released() {
        let env = Env::default();
        let actor = Address::generate(&env);
        escrow_released(&env, 2, &actor);
        assert_event(&env, ESCROW_RELEASED, 2, &actor);
    }

    #[test]
    fn emits_escrow_refunded() {
        let env = Env::default();
        let actor = Address::generate(&env);
        escrow_refunded(&env, 3, &actor);
        assert_event(&env, ESCROW_REFUNDED, 3, &actor);
    }

    #[test]
    fn emits_escrow_expired() {
        let env = Env::default();
        let actor = Address::generate(&env);
        escrow_expired(&env, 4, &actor);
        assert_event(&env, ESCROW_EXPIRED, 4, &actor);
    }

    #[test]
    fn emits_contract_paused() {
        let env = Env::default();
        let actor = Address::generate(&env);
        contract_paused(&env, &actor);
        assert_event(&env, CONTRACT_PAUSED, 0, &actor);
    }

    #[test]
    fn emits_contract_upgraded() {
        let env = Env::default();
        let actor = Address::generate(&env);
        contract_upgraded(&env, &actor);
        assert_event(&env, CONTRACT_UPGRADED, 0, &actor);
    }
}
