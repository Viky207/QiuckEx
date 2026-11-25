const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { canonicalJson, validateGate } = require('./verify-mainnet-deployment-gate');

const security = generateKeyPairSync('ed25519');
const governance = generateKeyPairSync('ed25519');
const commit = 'a'.repeat(40);
const wasmHash = 'b'.repeat(64);
const testnetDigest = 'c'.repeat(64);
const auditDigest = 'd'.repeat(64);
const attestationDigest = 'f'.repeat(64);
const workflowRef = 'quickex/quickex/.github/workflows/release.yml@refs/heads/main';
const reviewerKeys = {
  security: { role: 'security', public_key: security.publicKey },
  governance: { role: 'governance', public_key: governance.publicKey },
};

function createGate() {
  const gate = {
    version: 1,
    network: 'mainnet',
    release_commit: commit,
    wasm_sha256: wasmHash,
    testnet_manifest_sha256: testnetDigest,
    created_at: '2026-09-25T12:00:00.000Z',
    evidence: {
      audit_report_sha256: auditDigest,
      audit_report_url: 'https://quickex.example/audit.pdf',
      critical_findings: 0,
      high_findings: 0,
      medium_mitigations_verified: true,
      invariant_suite: { passed: true, commit, run_url: 'https://ci.example/invariants' },
      testnet_burn_in: {
        started_at: '2026-09-01T00:00:00.000Z',
        completed_at: '2026-09-15T00:00:00.000Z',
        synthetic_escrows: 10000,
        unhandled_incidents: 0,
        evidence_url: 'https://quickex.example/burn-in',
      },
      reproducible_build: { commit, wasm_sha256: wasmHash, run_url: 'https://ci.example/reproducible' },
      observability: { pager_tested: true, runbook_url: 'https://quickex.example/runbook' },
      provenance: {
        repository: 'quickex/quickex',
        commit,
        workflow: workflowRef,
        artifact_sha256: attestationDigest,
        attestation_url: 'https://github.com/quickex/quickex/attestations/1234',
        verified: true,
      },
    },
  };
  const message = Buffer.from(canonicalJson(gate));
  gate.approvals = [
    { key_id: 'security', signature: sign(null, message, security.privateKey).toString('base64') },
    { key_id: 'governance', signature: sign(null, message, governance.privateKey).toString('base64') },
  ];
  return gate;
}

function options() {
  return {
    wasmHash,
    commit,
    testnetManifest: { network: 'testnet', contracts: [{ name: 'quickex', wasm_hash: `0x${wasmHash}` }] },
    testnetManifestSha256: testnetDigest,
    auditReportSha256: auditDigest,
    attestationDigest,
    reviewerKeys,
    now: Date.parse('2026-09-26T12:00:00.000Z'),
  };
}

test('accepts a current gate with distinct security and governance signatures', () => {
  assert.doesNotThrow(() => validateGate(createGate(), options()));
});

test('rejects changed release artifacts after reviewer signing', () => {
  const gate = createGate();
  gate.wasm_sha256 = 'e'.repeat(64);
  assert.throws(() => validateGate(gate, options()), /WASM hash/);
});

test('rejects missing governance quorum', () => {
  const gate = createGate();
  gate.approvals = gate.approvals.slice(0, 1);
  assert.throws(() => validateGate(gate, options()), /one security and one governance/);
});

test('rejects insufficient testnet burn-in', () => {
  const gate = createGate();
  gate.evidence.testnet_burn_in.synthetic_escrows = 9999;
  assert.throws(() => validateGate(gate, options()), /10,000 synthetic escrows/);
});

test('rejects a gate without provenance attestation', () => {
  const gate = createGate();
  delete gate.evidence.provenance;
  assert.throws(() => validateGate(gate, options()), /provenance attestation/i);
});

test('rejects an attestation whose digest does not match the artifact', () => {
  const gate = createGate();
  gate.evidence.provenance.artifact_sha256 = 'e'.repeat(64);
  assert.throws(() => validateGate(gate, options()), /attestation digest/i);
});

test('rejects an attestation whose commit does not match the release commit', () => {
  const gate = createGate();
  gate.evidence.provenance.commit = 'e'.repeat(40);
  assert.throws(() => validateGate(gate, options()), /attestation commit/i);
});

test('rejects an unverified attestation', () => {
  const gate = createGate();
  gate.evidence.provenance.verified = false;
  assert.throws(() => validateGate(gate, options()), /attestation/i);
});

test('accepts a gate with a verified provenance attestation', () => {
  assert.doesNotThrow(() => validateGate(createGate(), options()));
});