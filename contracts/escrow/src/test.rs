use super::*;
use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env};

fn setup() -> (Env, EscrowContractClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let arbiter = Address::generate(&env);
    (env, client, sender, recipient, arbiter)
}

#[test]
fn create_requires_sender_authorization() {
    let (env, client, sender, recipient, arbiter) = setup();
    let amount = 1000i128;
    let deadline = env.ledger().timestamp() + 1000;

    // Unauthorized: no auths mocked at all.
    env.set_auths(&[]);
    let res = client.try_create(&sender, &recipient, &arbiter, &amount, &deadline);
    assert!(res.is_err(), "create must fail without sender authorization");

    // Valid: sender authorizes.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &sender,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &client.address,
            fn_name: "create",
            args: (&sender, &recipient, &arbiter, amount, deadline).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.create(&sender, &recipient, &arbiter, &amount, &deadline);
}

#[test]
fn release_requires_sender_authorization_and_binds_escrow() {
    let (env, client, sender, recipient, arbiter) = setup();
    let amount = 1000i128;
    let deadline = env.ledger().timestamp() + 1000;
    let escrow_id = client.create(&sender, &recipient, &arbiter, &amount, &deadline);

    // Unauthorized: recipient cannot release.
    env.set_auths(&[]);
    let res = client.try_release(&escrow_id, &recipient);
    assert!(res.is_err(), "release must fail for unauthorized caller");

    // Cross-escrow: authorization for a different escrow id must not satisfy.
    let other_id = escrow_id + 1;
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &sender,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &client.address,
            fn_name: "release",
            args: (&other_id, &sender).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let res = client.try_release(&escrow_id, &sender);
    assert!(res.is_err(), "release must fail when auth is bound to another escrow");

    // Valid nested authorization: sender authorizes release of this escrow.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &sender,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &client.address,
            fn_name: "release",
            args: (&escrow_id, &sender).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.release(&escrow_id, &sender);
}

#[test]
fn refund_requires_arbiter_authorization() {
    let (env, client, sender, recipient, arbiter) = setup();
    let amount = 1000i128;
    let deadline = env.ledger().timestamp() + 1000;
    let escrow_id = client.create(&sender, &recipient, &arbiter, &amount, &deadline);

    // Unauthorized: sender cannot refund.
    env.set_auths(&[]);
    let res = client.try_refund(&escrow_id, &sender);
    assert!(res.is_err(), "refund must fail for unauthorized caller");

    // Valid: arbiter authorizes refund.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &arbiter,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &client.address,
            fn_name: "refund",
            args: (&escrow_id, &arbiter).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.refund(&escrow_id, &arbiter);
}

#[test]
fn extend_requires_sender_authorization() {
    let (env, client, sender, recipient, arbiter) = setup();
    let amount = 1000i128;
    let deadline = env.ledger().timestamp() + 1000;
    let escrow_id = client.create(&sender, &recipient, &arbiter, &amount, &deadline);
    let new_deadline = deadline + 1000;

    // Unauthorized: recipient cannot extend.
    env.set_auths(&[]);
    let res = client.try_extend(&escrow_id, &recipient, &new_deadline);
    assert!(res.is_err(), "extend must fail for unauthorized caller");

    // Valid: sender authorizes extend.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &sender,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &client.address,
            fn_name: "extend",
            args: (&escrow_id, &sender, new_deadline).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.extend(&escrow_id, &sender, &new_deadline);
}

#[test]
fn pause_requires_admin_authorization() {
    let (env, client, _sender, _recipient, _arbiter) = setup();
    let admin = Address::generate(&env);

    // Unauthorized: non-admin cannot pause.
    env.set_auths(&[]);
    let res = client.try_pause(&admin);
    assert!(res.is_err(), "pause must fail for unauthorized caller");

    // Valid: admin authorizes pause.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &admin,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &client.address,
            fn_name: "pause",
            args: (&admin,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.pause(&admin);
}
