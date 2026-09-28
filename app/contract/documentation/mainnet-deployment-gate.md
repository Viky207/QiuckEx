# Mainnet Deployment Gate

Mainnet deployment is blocked unless the release has a current, signed gate artifact. The gate is checked before any install or deploy transaction by both `scripts/deploy.sh` and the backend `soroban:deploy` command.

## Required Evidence

The gate JSON binds the approval to the exact `release_commit`, compiled `wasm_sha256`, and SHA-256 of the deployed testnet manifest. The command also verifies the supplied testnet manifest identifies a completed testnet deployment and hashes the supplied audit report file before trusting either digest.

The `evidence` object must contain:

- `audit_report_sha256` and `audit_report_url` for an independent security audit, plus zero unresolved critical/high findings and verified mitigations for medium findings.
- `invariant_suite` with `passed: true`, the exact release commit, and a CI run URL.
- `testnet_burn_in` covering at least 14 completed days, at least 10,000 synthetic escrows, zero unhandled incidents, and an evidence URL.
- `reproducible_build` with the exact commit and WASM hash plus a CI run URL.
- `observability` with `pager_tested: true` and a runbook URL.

Approvals sign the canonical JSON gate payload with its `approvals` property removed. At least two distinct trusted Ed25519 keys are required: one configured with role `security`, one with role `governance`. Approval signatures are separate from the deployment-manifest signing key. Gate approvals expire after seven days.

## Trusted Reviewer Keys

Provide the public keyring to the operator environment as `QUICKEX_MAINNET_REVIEWER_PUBLIC_KEYS`, a JSON object keyed by reviewer key ID:

```json
{
  "security-2026": {
    "role": "security",
    "public_key": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
  },
  "governance-2026": {
    "role": "governance",
    "public_key": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
  }
}
```

Keep reviewer private keys in hardware-backed or approved secret storage. Do not place private keys or signed production evidence in the repository.

Registry publication uses a separate deploy automation key. Configure `CONTRACT_REGISTRY_MANIFEST_PUBLIC_KEYS` on the backend as a JSON object mapping `QUICKEX_REGISTRY_MANIFEST_KEY_ID` to the Ed25519 public-key PEM. Set `QUICKEX_REGISTRY_MANIFEST_PRIVATE_KEY` only in the protected deployment environment. The registry rejects missing, untrusted, or altered signatures; manual mainnet registry upserts are disabled.

The signature is Ed25519 over UTF-8 canonical JSON for the request body after removing `manifestKeyId` and `manifestSignature`. Object keys are sorted lexicographically, arrays retain their submitted order, and undefined properties are omitted. The request includes a UTC `manifestTimestamp` accepted for five minutes (with one minute of clock skew); `deploymentId` is unique and safe retries with the same payload are idempotent.

## Deployment Command

After evidence owners sign the same gate payload, pass the gate, testnet manifest, and audit report to the deploy command:

```bash
./scripts/deploy.sh \
  --network mainnet \
  --source quickex-mainnet \
  --admin "$QUICKEX_MAINNET_ADMIN" \
  --wasm target/wasm32v1-none/release/quickex.wasm \
  --mainnet-gate /secure/release/mainnet-gate.json \
  --testnet-manifest /secure/release/testnet-deployment-manifest.json \
  --audit-report /secure/release/security-audit.pdf
```

The verifier rejects mismatched commit, WASM, manifest, or audit digests; stale approvals; missing evidence; invalid signatures; repeated reviewers; and missing role quorum. A rejected gate stops before the first network transaction. Keep the approved gate with the release evidence and update the environment registry only after post-deployment checks pass.