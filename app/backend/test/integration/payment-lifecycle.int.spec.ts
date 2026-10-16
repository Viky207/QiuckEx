import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";

import app from "../../src/app";
import { supabase } from "../../src/lib/supabase";
import { horizonServer } from "../../src/lib/stellar";

/**
 * Integration coverage for the full payment link lifecycle (#388).
 *
 * Exercises: claim username -> create payment link -> submit a Horizon
 * testnet payment -> verify it appears in GET /payments/{username} -> verify
 * the earnings total updates -> delete the username and confirm the link is
 * invalidated.
 *
 * Runs against STELLAR_NETWORK=testnet with a seeded test account whose
 * mnemonic is provided via CI secrets (TEST_ACCOUNT_MNEMONIC). Each run
 * creates and tears down its own usernames so state never leaks between runs.
 */

const NETWORK = process.env.STELLAR_NETWORK ?? "testnet";
const TEST_MNEMONIC = process.env.TEST_ACCOUNT_MNEMONIC;

// Unique per-run suffix keeps parallel/retried runs from colliding.
const RUN_ID = `${Date.now().toString(36)}${Math.random()
  .toString(36)
  .slice(2, 8)}`;
const USERNAME = `itest${RUN_ID}`;
const PAYMENT_AMOUNT = "1.0000000";

const describeIntegration = TEST_MNEMONIC ? describe : describe.skip;

describeIntegration("payment link lifecycle (integration)", () => {
  let testKeypair: Keypair;
  let linkAddress: string;

  beforeAll(async () => {
    expect(NETWORK).toBe("testnet");
    testKeypair = Keypair.fromMnemonic(TEST_MNEMONIC as string);
  });

  afterAll(async () => {
    // Teardown: remove any rows this run created so state is not polluted.
    await supabase.from("payments").delete().eq("username", USERNAME);
    await supabase.from("links").delete().eq("username", USERNAME);
    await supabase.from("users").delete().eq("username", USERNAME);
  });

  it("claims a username and stores it in Supabase", async () => {
    const res = await request(app)
      .post("/users")
      .send({ username: USERNAME, address: testKeypair.publicKey() });

    expect(res.status).toBeLessThan(300);

    const { data, error } = await supabase
      .from("users")
      .select("username, address")
      .eq("username", USERNAME)
      .single();

    expect(error).toBeNull();
    expect(data?.username).toBe(USERNAME);
    expect(data?.address).toBe(testKeypair.publicKey());
  });

  it("creates a payment link with the expected response structure", async () => {
    const res = await request(app)
      .post("/links")
      .send({ username: USERNAME, amount: PAYMENT_AMOUNT });

    expect(res.status).toBeLessThan(300);
    expect(res.body).toEqual(
      expect.objectContaining({
        username: USERNAME,
        address: expect.any(String),
      }),
    );

    linkAddress = res.body.address;
    expect(linkAddress).toBeTruthy();
  });

  it("records a Horizon testnet payment against the link", async () => {
    // Submit a real testnet payment to the link address, then confirm the
    // backend surfaces it via GET /payments/{username}.
    const account = await horizonServer.loadAccount(testKeypair.publicKey());
    const tx = new (require("@stellar/stellar-sdk").TransactionBuilder)(
      account,
      { fee: "100", networkPassphrase: require("@stellar/stellar-sdk").Networks.TESTNET },
    )
      .addOperation(
        require("@stellar/stellar-sdk").Operation.payment({
          destination: linkAddress,
          asset: require("@stellar/stellar-sdk").Asset.native(),
          amount: PAYMENT_AMOUNT,
        }),
      )
      .setTimeout(30)
      .build();

    tx.sign(testKeypair);
    await horizonServer.submitTransaction(tx);

    const res = await request(app).get(`/payments/${USERNAME}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.payments)).toBe(true);
    expect(res.body.payments.length).toBeGreaterThan(0);
  });

  it("updates the earnings total for the username", async () => {
    const res = await request(app).get(`/payments/${USERNAME}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBeDefined();
    expect(Number(res.body.total)).toBeGreaterThanOrEqual(
      Number(PAYMENT_AMOUNT),
    );
  });

  it("deletes the username and invalidates the link", async () => {
    const del = await request(app).delete(`/users/${USERNAME}`);
    expect(del.status).toBeLessThan(300);

    const { data } = await supabase
      .from("users")
      .select("username")
      .eq("username", USERNAME)
      .maybeSingle();
    expect(data).toBeNull();

    const res = await request(app).get(`/payments/${USERNAME}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
