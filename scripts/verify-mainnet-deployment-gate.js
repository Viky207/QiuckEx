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

function validateProvenanceAttestation(attestation, options) {
  const { wasmHash, commit, repository, workflow, now = Date.now() } = options;
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    throw new Error('Build provenance attestation is required');
  }
  const subject = Array.isArray(attestation.subject) ? attestation.subject : [];
  const digest = wasmHash.toLowerCase();
  const matchesArtifact = subject.some((entry) =>
    String(entry?.digest?.sha256 ?? '').toLowerCase() === digest);
  if (!matchesArtifact) {
    throw new Error('Build provenance attestation does not cover the WASM artifact digest');
  }
  if (attestation.repository !== repository) {
    throw new Error('Build provenance attestation repository does not match the release repository');
  }
  if (attestation.commit !== commit) {
    throw new Error('Build provenance attestation commit does not match the checked-out commit');
  }
  if (attestation.workflow !== workflow) {
    throw new Error('Build provenance attestation workflow does not match the release workflow');
  }
  const createdAt = Date.parse(attestation.created_at);
  if (!Number.isFinite(createdAt) || createdAt > now) {
    throw new Error('Build provenance attestation must have a valid creation timestamp');
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

function validateReleaseManifest(manifest, options) {
  const { imageDigest, wasmHash, commit } = options;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Release manifest is required');
  }
  if (manifest.version !== 1) throw new Error('Release manifest must be version 1');
  if (!/^[a-f0-9]{40}$/i.test(manifest.commit ?? '') || manifest.commit !== commit) {
    throw new Error('Release manifest commit does not match the checked-out commit');
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error('Release manifest must list at least one artifact');
  }
  const digest = normalizeDigest(imageDigest);
  const expectedWasm = String(wasmHash ?? '').toLowerCase();
  const seen = new Set();
  let matchedImage = false;
  let matchedWasm = false;
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact !== 'object') throw new Error('Release manifest artifacts must be objects');
    const name = String(artifact.name ?? '');
    if (!name) throw new Error('Release manifest artifacts must have a name');
    if (seen.has(name)) throw new Error(`Duplicate release manifest artifact: ${name}`);
    seen.add(name);
    if (artifact.commit !== commit) {
      throw new Error(`Release manifest artifact ${name} commit does not match the checked-out commit`);
    }
    const artifactDigest = normalizeDigest(artifact.digest);
    if (!/^[a-f0-9]{64}$/.test(artifactDigest)) {
      throw new Error(`Release manifest artifact ${name} digest must be a sha256 digest`);
    }
    if (artifact.type === 'container-image' && artifactDigest === digest) matchedImage = true;
    if (artifact.type === 'wasm' && artifactDigest === expectedWasm) matchedWasm = true;
  }
  if (!matchedImage) throw new Error('Release manifest does not contain the deployed image digest');
  if (!matchedWasm) throw new Error('Release manifest does not contain the deployed WASM hash');
  return { commit, artifacts: manifest.artifacts.length };
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

function verifyAttestationWithGh(attestationPath, wasmPath, repository) {
  try {
    execFileSync('gh', [
      'attestation', 'verify', wasmPath,
      '--repo', repository,
      '--bundle', attestationPath,
      '--format', 'json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`gh attestation verify failed: ${error.message}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ['gate', 'testnet-manifest', 'audit-report', 'wasm', 'image-digest', 'image-signature', 'image-provenance', 'expected-source-repo', 'release-manifest']) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  const gate = JSON.parse(fs.readFileSync(args.gate, 'utf8'));
  const testnetManifest = JSON.parse(fs.readFileSync(args['testnet-manifest'], 'utf8'));
  const wasmHash = sha256(args.wasm);
  const commit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const repository = process.env.GITHUB_REPOSITORY;
  const workflow = process.env.GITHUB_WORKFLOW_REF;
  if (!repository || !workflow) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_WORKFLOW_REF are required to verify build provenance');
  }
  const attestation = JSON.parse(fs.readFileSync(args.attestation, 'utf8'));
  validateProvenanceAttestation(attestation, { wasmHash, commit, repository, workflow });
  verifyAttestationWithGh(args.attestation, args.wasm, repository);
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
  const releaseManifest = JSON.parse(fs.readFileSync(args['release-manifest'], 'utf8'));
  const manifestResult = validateReleaseManifest(releaseManifest, {
    imageDigest: args['image-digest'],
    wasmHash,
    commit,
  });
  console.log(`Image verification: digest=sha256:${signatureResult.digest} signer=${signatureResult.signer} source=${provenanceResult.sourceRepo} result=verified`);
  console.log(`Release manifest verified: commit=${manifestResult.commit} artifacts=${manifestResult.artifacts}`);
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
  validateProvenanceAttestation,
  validateImageSignature,
  validateImageProvenance,
  validateReleaseManifest,
  normalizeDigest,
  validateDeployFreeze,
};
