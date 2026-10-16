# Developer Onboarding Guide

From `git clone` to your first test payment on Stellar testnet in under 15 minutes.

This guide is chronological. Follow the steps in order and check the expected output at each stage before moving on.

---

## 1. Prerequisites check

You need three things installed or available before you start:

- **Node.js 20**
- **pnpm 10**
- **A Stellar testnet account** (you can create one in step 5)

Verify Node and pnpm:

```bash
node --version
pnpm --version
```

Expected output (versions may be slightly newer, but the majors must match):

```text
v20.11.1
10.4.1
```

If `node --version` prints anything other than `v20.x`, install Node 20 (for example with [nvm](https://github.com/nvm-sh/nvm): `nvm install 20 && nvm use 20`).

If `pnpm --version` prints anything other than `10.x`, install it with `corepack enable && corepack prepare pnpm@10 --activate`.

---

## 2. Clone + install

```bash
git clone https://github.com/<your-org>/<your-repo>.git
cd <your-repo>
pnpm install
```

Expected output (tail):

```text
Packages: +1234
Progress: resolved 1234, reused 1200, downloaded 34, added 1234, done
Done in 42.1s
```

If the install fails, see [Troubleshooting](#troubleshooting).

---

## 3. Configure the backend environment

The backend reads its configuration from `app/backend/.env`. Start from the example file:

```bash
cp .env.example app/backend/.env
```

Open `app/backend/.env` and fill in the **two mandatory fields**:

```dotenv
# Mandatory: the Stellar network this instance talks to
STELLAR_NETWORK=testnet

# Mandatory: the secret key of the account that signs test payments
STELLAR_SECRET_KEY=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

- `STELLAR_NETWORK` must be `testnet` for local development.
- `STELLAR_SECRET_KEY` is the secret key (`S...`) of the testnet account you will fund in step 5. You can leave it blank for now and come back after step 5.

Expected result: `app/backend/.env` exists and contains both keys with non-empty values.

---

## 4. Start the dev server

```bash
pnpm dev
```

Expected console output:

```text
> backend@ dev /path/to/repo/app/backend
> tsx watch src/index.ts

[backend] listening on http://localhost:3000
[backend] connected to Stellar testnet
[frontend] ready on http://localhost:5173
```

Open the app in your browser:

```text
http://localhost:5173
```

You should see the app landing page. Leave this terminal running for the rest of the guide.

---

## 5. Fund a testnet account

1. Open [laboratory.stellar.org](https://laboratory.stellar.org/#account-creator?network=testnet).
2. Make sure the network selector is set to **Testnet**.
3. Click **Generate keypair**. Copy the **public key** (`G...`) and the **secret key** (`S...`).
4. Click **Create account** to fund it with testnet XLM via Friendbot.

Expected output:

```text
Success! Account created and funded with 10,000 XLM.
Public Key: GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Now paste the **secret key** into `STELLAR_SECRET_KEY` in `app/backend/.env` and restart `pnpm dev` so the backend picks it up.

---

## 6. Claim a username

In the running app at `http://localhost:5173`:

1. Click **Claim username**.
2. Enter a username (for example `alice-testnet`) and confirm.

Expected output: the app redirects to your profile page and shows the username you just claimed:

```text
http://localhost:5173/alice-testnet
```

---

## 7. Generate a payment link

1. From your profile page, click **Create payment link**.
2. Enter an amount (for example `1`) and a short memo.
3. Click **Generate**.

Expected output: the app shows a shareable link and a QR code:

```text
http://localhost:5173/pay/alice-testnet?amount=1&memo=hello
```

Copy the link — you will use it in the next step.

---

## 8. Send a test payment

1. Open the payment link from step 7 in a new browser tab.
2. Confirm the amount and memo, then click **Pay**.
3. Approve the transaction in your Stellar wallet (or use the testnet account from step 5).

Expected output in the app:

```text
Payment sent
1 XLM to alice-testnet
Transaction: abc123...def456
```

Expected output in the backend console:

```text
[backend] payment received: 1 XLM -> alice-testnet (tx abc123...def456)
```

Go back to your dashboard at `http://localhost:5173/dashboard`. The payment now appears in the list:

```text
+1 XLM   from GXXXX...XXXX   just now
```

You have completed onboarding. 🎉

---

## Troubleshooting

### 1. `pnpm install` fails with `ERR_PNPM_UNSUPPORTED_ENGINE`

You are running the wrong Node or pnpm major. Check with `node --version` and `pnpm --version`; both must be `20.x` and `10.x` respectively. Fix with `nvm install 20 && nvm use 20` and `corepack prepare pnpm@10 --activate`, then delete `node_modules` and re-run `pnpm install`.

### 2. Backend exits with `Missing required env var: STELLAR_SECRET_KEY`

`app/backend/.env` is missing or incomplete. Confirm you copied `.env.example` to `app/backend/.env` (not the repo root) and that both `STELLAR_NETWORK` and `STELLAR_SECRET_KEY` are set to non-empty values. Restart `pnpm dev` after editing the file.

### 3. Payment fails with `Account not found` or `op_underfunded`

Your testnet account was not funded, or you are pointing at mainnet. Re-open [laboratory.stellar.org](https://laboratory.stellar.org/#account-creator?network=testnet), confirm the network is **Testnet**, and fund the account again. Make sure `STELLAR_NETWORK=testnet` in `app/backend/.env` and that the secret key matches the funded account.

---

## Next steps

- Read the architecture overview in the main `README.md`.
- Browse the API routes under `app/backend/src`.
- Pick up a `good first issue` and open a PR.
