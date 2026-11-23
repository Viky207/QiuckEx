const fs = require('fs');
const path = require('path');
const { createHash, createPublicKey, verify } = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function requireHttps(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTPS URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must be an HTTPS URL`);
}

function validateGate(gate, options) {
  const { wasmHash, commit, testnetManifest, testnetManifestSha256, auditReportSha256, reviewerKeys, now = Date.now() } = options;
  if (gate.version !== 1 || gate.network !== 'mainnet') throw new Error('Gate must be version 1 and target mainnet');
  if (!/^[a-f0-9]{40}$/i.test(gate.release_commit ?? '') || gate.release_commit !== commit) {
    throw new Error('Gate release_commit must match the checked-out commit');
  }
  if ((gate.wasm_sha256 ?? '').toLowerCase() !== wasmHash.toLowerCase()) {
    throw new Error('Gate WASM hash does not match the artifact to deploy');
  }
  if ((gate.testnet_manifest_sha256 ?? '').toLowerCase() !== testnetManifestSha256.toLowerCase()) {
    throw new Error('Gate testnet manifest digest does not match the supplied manifest');
  }
  if (testnetManifest.network !== 'testnet' || !Array.isArray(testnetManifest.contracts) || testnetManifest.contracts.length === 0) {
    throw new Error('Gate must reference a deployment manifest for a completed testnet deployment');
  }
  if (!testnetManifest.contracts.some((contract) =>
    String(contract.wasm_hash ?? '').replace(/^0x/i, '').toLowerCase() === wasmHash.toLowerCase())) {
    throw new Error('Testnet manifest does not contain the exact WASM artifact approved for mainnet');
  }

  const evidence = gate.evidence ?? {};
  if (!/^[a-f0-9]{64}$/i.test(evidence.audit_report_sha256 ?? '') || evidence.audit_report_sha256.toLowerCase() !== auditReportSha256.toLowerCase()) {
    throw new Error('Gate audit report digest does not match the supplied audit report');
  }
  requireHttps(evidence.audit_report_url, 'audit_report_url');
  if (evidence.critical_findings !== 0 || evidence.high_findings !== 0 || evidence.medium_mitigations_verified !== true) {
    throw new Error('Audit evidence must have zero unresolved critical/high findings and verified medium mitigations');
  }
  if (evidence.invariant_suite?.passed !== true || evidence.invariant_suite?.commit !== gate.release_commit) {
    throw new Error('Invariant suite evidence must pass for the reviewed release commit');
  }
  requireHttps(evidence.invariant_suite?.run_url, 'invariant_suite.run_url');

  const burnIn = evidence.testnet_burn_in;
  const start = Date.parse(burnIn?.started_at);
  const end = Date.parse(burnIn?.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 14 * DAY_MS || end > now) {
    throw new Error('Testnet burn-in evidence must cover at least 14 completed consecutive days');
  }
  if (!Number.isInteger(burnIn?.synthetic_escrows) || burnIn.synthetic_escrows < 10000 || burnIn?.unhandled_incidents !== 0) {
    throw new Error('Testnet burn-in requires at least 10,000 synthetic escrows and zero unhandled incidents');
  }
  requireHttps(burnIn?.evidence_url, 'testnet_burn_in.evidence_url');

  if (evidence.reproducible_build?.commit !== gate.release_commit ||
      (evidence.reproducible_build?.wasm_sha256 ?? '').toLowerCase() !== wasmHash.toLowerCase()) {
    throw new Error('Reproducible-build evidence must match the reviewed commit and WASM hash');
  }
  requireHttps(evidence.reproducible_build?.run_url, 'reproducible_build.run_url');
  if (evidence.observability?.pager_tested !== true) throw new Error('Observability evidence must confirm a successful pager test');
  requireHttps(evidence.observability?.runbook_url, 'observability.runbook_url');

  const createdAt = Date.parse(gate.created_at);
  if (!Number.isFinite(createdAt) || createdAt > now || now - createdAt > 7 * DAY_MS) {
    throw new Error('Mainnet gate approvals must be no more than seven days old');
  }

  if (!Array.isArray(gate.approvals)) throw new Error('Gate approvals are required');
  const { approvals, ...signedPayload } = gate;
  const message = Buffer.from(canonicalJson(signedPayload));
  const seen = new Set();
  const seenPublicKeys = new Set();
  const roles = new Set();
  for (const approval of approvals) {
    if (seen.has(approval.key_id)) throw new Error(`Duplicate approval from ${approval.key_id}`);
    seen.add(approval.key_id);
    const trustedKey = reviewerKeys[approval.key_id];
    if (!trustedKey || !['security', 'governance'].includes(trustedKey.role)) {
      throw new Error(`Untrusted mainnet reviewer key: ${approval.key_id}`);
    }
    const publicKeyFingerprint = createHash('sha256')
      .update(createPublicKey(trustedKey.public_key).export({ type: 'spki', format: 'der' }))
      .digest('hex');
    if (seenPublicKeys.has(publicKeyFingerprint)) throw new Error('Security and governance approvals must use distinct keys');
    seenPublicKeys.add(publicKeyFingerprint);
    if (roles.has(trustedKey.role)) throw new Error(`Mainnet gate requires distinct security and governance reviewers`);
    let signature;
    try {
      signature = Buffer.from(approval.signature, 'base64');
    } catch {
      throw new Error(`Invalid approval signature for ${approval.key_id}`);
    }
    if (signature.length !== 64 || !verify(null, message, trustedKey.public_key, signature)) {
      throw new Error(`Invalid approval signature for ${approval.key_id}`);
    }
    roles.add(trustedKey.role);
  }
  if (!roles.has('security') || !roles.has('governance')) {
    throw new Error('Mainnet gate requires one security and one governance approval');
  }
}

function readImageSigningKeys() {
  const raw = process.env.QUICKEX_IMAGE_SIGNING_PUBLIC_KEYS ?? process.env.QUICKEX_MAINNET_REVIEWER_PUBLIC_KEYS ?? '{}';
  let keys;
  try {
    keys = JSON.parse(raw);
  } catch {
    throw new Error('QUICKEX_IMAGE_SIGNING_PUBLIC_KEYS must be valid JSON');
  }
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
    throw new Error('QUICKEX_IMAGE_SIGNING_PUBLIC_KEYS must map key IDs to public keys');
  }
  return keys;
}

function normalizeDigest(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^sha256:/, '');
}

function validateImageSignature(signature, options) {
  const { imageDigest, commit, signingKeys } = options;
  const digest = normalizeDigest(imageDigest);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Image digest must be a sha256 digest');
  if (!signature || typeof signature !== 'object') throw new Error('Image signature is required; refusing to deploy an unsigned image');
  if (normalizeDigest(signature.digest) !== digest) {
    throw new Error('Image signature digest does not match the image to deploy');
  }
  if (signature.commit !== commit) {
    throw new Error('Image signature commit does not match the checked-out commit');
  }
  const trustedKey = signingKeys?.[signature.key_id];
  if (!trustedKey) throw new Error(`Untrusted image signing key: ${signature.key_id}`);
  const publicKey = typeof trustedKey === 'string' ? trustedKey : trustedKey.public_key;
  const message = Buffer.from(`${digest}\n${commit}`);
  let sig;
  try {
    sig = Buffer.from(signature.signature, 'base64');
  } catch {
    throw new Error(`Invalid image signature for ${signature.key_id}`);
  }
  if (sig.length !== 64 || !verify(null, message, publicKey, sig)) {
    throw new Error(`Invalid image signature for ${signature.key_id}`);
  }
  return { digest, signer: signature.key_id };
}

function validateImageProvenance(provenance, options) {
  const { imageDigest, commit, expectedSourceRepo } = options;
  const digest = normalizeDigest(imageDigest);
  if (!provenance || typeof provenance !== 'object') {
    throw new Error('Image provenance attestation is required');
  }
  if (normalizeDigest(provenance.digest) !== digest) {
    throw new Error('Image provenance digest does not match the image to deploy');
  }
  if (provenance.source_repo !== expectedSourceRepo) {
    throw new Error(`Image provenance source repo ${provenance.source_repo} does not match expected ${expectedSourceRepo}`);
  }
  if (provenance.commit !== commit) {
    throw new Error('Image provenance commit does not match the checked-out commit');
  }
  return { digest, sourceRepo: provenance.source_repo };
}

function validateDeployFreeze(freeze, options) {
  const { now = Date.now(), requireOverride = false } = options;
  if (freeze === undefined || freeze === null) {
    if (requireOverride) throw new Error('Deploy freeze state is required when an override is claimed');
    return;
  }
  if (typeof freeze !== 'object' || Array.isArray(freeze)) {
    throw new Error('Deploy freeze state must be an object');
  }
  if (typeof freeze.frozen !== 'boolean') throw new Error('Deploy freeze state must declare a boolean frozen flag');
  if (!freeze.frozen) {
    if (freeze.override !== undefined && freeze.override !== null) {
      throw new Error('Deploy freeze override must not be present when the environment is not frozen');
    }
    return;
  }
  const override = freeze.override;
  if (override === undefined || override === null) {
    throw new Error('Production promotion is blocked by an active deploy freeze');
  }
  if (typeof override !== 'object' || Array.isArray(override)) {
    throw new Error('Deploy freeze override must be an object');
  }
  if (typeof override.actor !== 'string' || override.actor.trim() === '') {
    throw new Error('Deploy freeze override must record the authorizing actor');
  }
  if (typeof override.reason !== 'string' || override.reason.trim() === '') {
    throw new Error('Deploy freeze override must record a reason');
  }
  const overrideAt = Date.parse(override.timestamp);
  if (!Number.isFinite(overrideAt) || overrideAt > now) {
    throw new Error('Deploy freeze override must record a valid timestamp that is not in the future');
  }
  if (override.approved !== true) {
    throw new Error('Deploy freeze override must be explicitly approved');
  }
}

function readReviewerKeys() {
  let keys;
  try {
    keys = JSON.parse(process.env.QUICKEX_MAINNET_REVIEWER_PUBLIC_KEYS ?? '{}');
  } catch {
    throw new Error('QUICKEX_MAINNET_REVIEWER_PUBLIC_KEYS must be valid JSON');
  }
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
    throw new Error('QUICKEX_MAINNET_REVIEWER_PUBLIC_KEYS must map key IDs to reviewer roles and public keys');
  }
  return keys;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`Expected a value after ${key}`);
    }
    args[key.slice(2)] = argv[++index];
  }
  return args;
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ['gate', 'testnet-manifest', 'audit-report', 'wasm', 'image-digest', 'image-signature', 'image-provenance', 'expected-source-repo']) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  const gate = JSON.parse(fs.readFileSync(args.gate, 'utf8'));
  const testnetManifest = JSON.parse(fs.readFileSync(args['testnet-manifest'], 'utf8'));
  const wasmHash = sha256(args.wasm);
  const commit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  validateGate(gate, {
    wasmHash,
    commit,
    testnetManifest,
    testnetManifestSha256: sha256(args['testnet-manifest']),
    auditReportSha256: sha256(args['audit-report']),
    reviewerKeys: readReviewerKeys(),
  });
  const imageSignature = JSON.parse(fs.readFileSync(args['image-signature'], 'utf8'));
  const imageProvenance = JSON.parse(fs.readFileSync(args['image-provenance'], 'utf8'));
  const signingKeys = readImageSigningKeys();
  const signatureResult = validateImageSignature(imageSignature, {
    imageDigest: args['image-digest'],
    commit,
    signingKeys,
  });
  const provenanceResult = validateImageProvenance(imageProvenance, {
    imageDigest: args['image-digest'],
    commit,
    expectedSourceRepo: args['expected-source-repo'],
  });
  console.log(`Image verification: digest=sha256:${signatureResult.digest} signer=${signatureResult.signer} source=${provenanceResult.sourceRepo} result=verified`);
  const freeze = args['deploy-freeze'] ? JSON.parse(fs.readFileSync(args['deploy-freeze'], 'utf8')) : undefined;
  validateDeployFreeze(freeze, { requireOverride: Boolean(args['deploy-freeze']) });
  if (freeze?.frozen) {
    console.log(`Mainnet deployment gate approved for ${commit} (WASM SHA-256 ${wasmHash}) under logged deploy freeze override by ${freeze.override.actor}.`);
    return;
  }
  console.log(`Mainnet deployment gate approved for ${commit} (WASM SHA-256 ${wasmHash}).`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Mainnet deployment gate rejected: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  canonicalJson,
  validateGate,
  validateImageSignature,
  validateImageProvenance,
  normalizeDigest,
  validateDeployFreeze,
};