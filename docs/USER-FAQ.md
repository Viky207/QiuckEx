# QuickEx — User FAQ

Answers to the questions we get most often in Discord and support. Written for everyday users — no blockchain background needed. If a term is unavoidable, it is explained the first time it appears.

> This document is also intended to be embedded in the web app's help section (a future `/help` page).

---

## What is QuickEx and how does it work?

QuickEx is a payment link platform built on the **Stellar** network. Stellar is a public payment network that settles transfers in a few seconds for a tiny fee.

You claim a short, shareable username such as `quickex.to/yourname`. Anyone can then pay you by opening that link — no app install required on their side. You can also generate a link for a specific amount and memo, like `quickex.to/yourname/50`, and share it as a QR code or a plain URL.

When someone pays, the funds go **directly to your own Stellar wallet**. QuickEx never holds your money (see "Is QuickEx custodial?" below). Your dashboard shows incoming payments, history, and totals by reading the public Stellar ledger.

---

## How do I claim a username? Can I change it?

1. Open QuickEx and connect your Stellar wallet.
2. Go to the username / profile section and enter the name you want.
3. Confirm the transaction in your wallet.

Usernames are stored in QuickEx's database and are unique — once a name is taken, it cannot be claimed by someone else.

**Changing a username:** you can update your username from the same profile section. Because links are how people find you, treat your username like a permanent address: if you change it, **old links pointing at your previous name will no longer reach you**, so update anywhere you have shared it. If you only need a different display name, prefer keeping the username stable.

---

## What wallets are supported?

QuickEx works with Stellar wallets. The two we test and recommend are:

- **Freighter** — browser extension and mobile, the recommended default.
- **Lobstr** — mobile and web.

Any wallet that can sign Stellar transactions and connect over WalletConnect should work, but Freighter and Lobstr are the ones we actively support. You always sign payments with your own wallet; QuickEx never asks for your secret key or recovery phrase.

---

## What assets can I receive? How do I add a custom asset?

You can receive:

- **XLM** — Stellar's native asset.
- **USDC** — the stablecoin most people use for payments.
- **Any other Stellar asset** that your wallet holds a trustline for.

A **trustline** is a small on-chain record that says "my wallet accepts this asset." You must have one before you can receive a non-native asset.

**To add a custom asset:**

1. In your wallet (e.g. Freighter or Lobstr), add the asset by its **asset code** and **issuer address**. Your wallet will create the trustline.
2. Once the trustline exists, the asset can be sent to your QuickEx username like any other.

If a payment link references an asset your wallet does not trust, the payment will fail — add the trustline first, then ask the sender to retry.

---

## What is X-Ray privacy and when should I use it?

**X-Ray** is QuickEx's optional privacy mode. Normally, Stellar payments are public: anyone can look up a transaction and see the amount and the addresses involved. X-Ray uses zero-knowledge proofs — a cryptographic technique that lets you prove a payment is valid **without revealing the amount or the sender** — to shield that information.

**When to use it:**

- You are receiving a payment and do not want the amount visible to the public.
- You want to hide who paid you.

**When you may not need it:**

- Everyday tips or public donations where transparency is fine.
- Situations where the recipient needs to independently verify the exact amount on-chain.

X-Ray is available on mainnet. It is optional per link — you choose whether to enable it when you generate a payment link.

---

## Are there fees? What are they?

- **QuickEx's platform fee: none.** Creating a username, generating links, and receiving payments is free.
- **Stellar network fee:** every Stellar transaction costs a tiny network fee, typically a fraction of a cent (well under 0.01¢). This is paid to the Stellar network, not to QuickEx.
- **X-Ray privacy:** shielded transactions may cost slightly more in network fees than a plain payment, because they do more work on-chain.
- **Asset conversion:** if you ever swap between assets, the swap provider may charge its own spread or fee.

You will always see the fee in your wallet before you confirm a transaction.

---

## My payment is not showing up — what should I check?

Work through these in order:

1. **Did the sender actually confirm?** A payment only counts once it is signed and submitted. Ask the sender for the transaction hash.
2. **Is it confirmed on the network?** Stellar settles in seconds, but occasionally a transaction is delayed. Look up the transaction hash on a Stellar explorer (e.g. stellar.expert) to see its status.
3. **Right network?** Testnet and mainnet are separate. A testnet payment will never appear in your mainnet balance. Check that both sides are on the same network.
4. **Right asset and trustline?** If the sender used an asset your wallet does not trust, the payment fails. Add the trustline and ask them to resend.
5. **Right username?** If you recently changed your username, an old link may point somewhere else. Confirm the link the sender used matches your current username.
6. **Dashboard lag?** The dashboard reads from the Stellar ledger and can take a few seconds to refresh. Reload the page.

If the transaction is confirmed on-chain to your address but still not visible, contact support with the transaction hash.

---

## Is QuickEx custodial? Who holds my funds?

**QuickEx is non-custodial.** We never hold your funds and never have access to them.

Payments route **directly to your own Stellar wallet**. QuickEx stores your username and link settings, and reads public ledger data to show your dashboard — it does not store your money or your secret key. You are always the one signing transactions with your wallet.

---

## What happens if I lose access to my wallet?

Your funds live on the Stellar network, controlled by your wallet's **secret key / recovery phrase**. QuickEx cannot recover them for you, because we never had access to them.

- **If you still have your recovery phrase:** restore your wallet in Freighter, Lobstr, or any Stellar wallet using that phrase. Your funds and your ability to receive payments come back.
- **If you have lost both the device and the recovery phrase:** the funds in that wallet are unrecoverable. This is true of any self-custody wallet.

**Protect yourself:** back up your recovery phrase offline, never share it with anyone (including anyone claiming to be QuickEx support), and never type it into a website.

---

## How do I report a scam or suspicious link?

QuickEx flags suspicious links automatically — for example, links with no memo or unusual patterns — but you should still report anything that looks wrong.

**To report:**

1. Do **not** connect your wallet or sign anything on the suspicious link.
2. Capture the full URL and, if possible, a screenshot.
3. Report it in the QuickEx Discord, or open an issue on the GitHub repository with the link and details.

**Red flags to watch for:**

- A link that asks for your **secret key or recovery phrase** — QuickEx never asks for these.
- A domain that is not `quickex.to` (look-alike spellings, extra words, unusual endings).
- Pressure to pay quickly, or a payment request you did not expect.

When in doubt, verify the username with the person directly through a channel you already trust before paying.

---

*English only for now. A Spanish translation is tracked as a follow-up.*
