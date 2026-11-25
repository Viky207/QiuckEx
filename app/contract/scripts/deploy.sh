#!/usr/bin/env bash
set -euo pipefail

# QuickEx Contract Deploy Script
# ===============================
# Builds, deploys, and initialises a QuickEx Soroban contract on the target
# network, then emits a JSON manifest conforming to manifest-schema.json.
#
# Prerequisites: cargo (wasm32v1-none target), stellar CLI, sha256sum, python3, node, git
#
# Usage:
#   ./scripts/deploy.sh \
#     --network testnet \
#     --source quickex-testnet \
#     --admin GA5TBSBGERHVMEFBJGEM3KYMRLWO73Y2QRAV6P66GPEBOJ5ZMJUT7LLY \
#     --wasm target/wasm32v1-none/release/quickex.wasm \
#     [--rpc-url https://soroban-testnet.stellar.org] \
#     [--passphrase "Test SDF Network ; September 2015"] \
#     [--out-dir docs/deployment-artifacts] \
#     [--freeze-override --override-actor <id> --override-reason <text>]
#
# Mainnet additionally requires --mainnet-gate, --testnet-manifest, and --audit-report.
#
# Deploy freeze
# -------------
# Before promoting, the script queries the backend deploy-freeze state for the
# target environment (DEPLOY_FREEZE_URL, default http://127.0.0.1:8080). If the
# environment is frozen the deployment aborts. An authorized operator may bypass
# the hold with --freeze-override, which requires --override-actor and
# --override-reason; the override is recorded in the backend audit log and in
# the emitted manifest. Dry runs and validation-only paths never query the
# freeze state.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK=""
SOURCE=""
ADMIN=""
WASM_PATH="${WASM_PATH:-$ROOT_DIR/target/wasm32v1-none/release/quickex.wasm}"
RPC_URL=""
PASSPHRASE=""
OUT_DIR="${OUT_DIR:-$ROOT_DIR/docs/deployment-artifacts}"
MAINNET_GATE_FILE="${MAINNET_GATE_FILE:-}"
TESTNET_MANIFEST="${TESTNET_MANIFEST:-}"
AUDIT_REPORT="${AUDIT_REPORT:-}"
STELLAR_BIN="${STELLAR_BIN:-stellar}"
SKIP_BUILD="${SKIP_BUILD:-0}"
DRY_RUN="${DRY_RUN:-0}"
DEPLOY_FREEZE_URL="${DEPLOY_FREEZE_URL:-http://127.0.0.1:8080}"
FREEZE_OVERRIDE=0
OVERRIDE_ACTOR=""
OVERRIDE_REASON=""
FREEZE_STATE="unknown"
FREEZE_OVERRIDE_RECORDED="false"
# Post-deploy readiness polling and automated rollback controls.
HEALTH_CHECK_ATTEMPTS="${HEALTH_CHECK_ATTEMPTS:-5}"
HEALTH_CHECK_INTERVAL="${HEALTH_CHECK_INTERVAL:-3}"
ROLLBACK_ENABLED="${ROLLBACK_ENABLED:-1}"
# Optional pre-deploy state file capturing the current deployment slot and
# image digest. When present, it is used to restore the prior healthy revision.
PRIOR_STATE_FILE="${PRIOR_STATE_FILE:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)    NETWORK="$2";   shift 2 ;;
    --source)     SOURCE="$2";    shift 2 ;;
    --admin)      ADMIN="$2";     shift 2 ;;
    --wasm)       WASM_PATH="$2"; shift 2 ;;
    --rpc-url)    RPC_URL="$2";   shift 2 ;;
    --passphrase) PASSPHRASE="$2"; shift 2 ;;
    --out-dir)    OUT_DIR="$2";   shift 2 ;;
    --mainnet-gate) MAINNET_GATE_FILE="$2"; shift 2 ;;
    --testnet-manifest) TESTNET_MANIFEST="$2"; shift 2 ;;
    --audit-report) AUDIT_REPORT="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1;   shift ;;
    --dry-run)    DRY_RUN=1;      shift ;;
    --freeze-override) FREEZE_OVERRIDE=1; shift ;;
    --override-actor)  OVERRIDE_ACTOR="$2";  shift 2 ;;
    --override-reason) OVERRIDE_REASON="$2"; shift 2 ;;
    --prior-state) PRIOR_STATE_FILE="$2"; shift 2 ;;
    --health-attempts) HEALTH_CHECK_ATTEMPTS="$2"; shift 2 ;;
    --health-interval) HEALTH_CHECK_INTERVAL="$2"; shift 2 ;;
    --no-rollback) ROLLBACK_ENABLED=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── Validation ──────────────────────────────────────────────────────────────

need(){ command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }; }
need python3
need sha256sum
need "$STELLAR_BIN"

if [[ -z "$NETWORK" ]]; then echo "error: --network is required" >&2; exit 1; fi
if [[ -z "$SOURCE" ]]; then echo "error: --source is required" >&2; exit 1; fi
if [[ -z "$ADMIN" ]]; then echo "error: --admin is required" >&2; exit 1; fi

if [[ "$FREEZE_OVERRIDE" == "1" ]]; then
  if [[ -z "$OVERRIDE_ACTOR" ]]; then
    echo "error: --freeze-override requires --override-actor" >&2
    exit 1
  fi
  if [[ -z "$OVERRIDE_REASON" ]]; then
    echo "error: --freeze-override requires --override-reason" >&2
    exit 1
  fi
fi

# ── Resolve network defaults ────────────────────────────────────────────────

case "$NETWORK" in
  testnet)
    RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"
    PASSPHRASE="${PASSPHRASE:-Test SDF Network ; September 2015}"
    ;;
  mainnet)
    RPC_URL="${RPC_URL:-https://mainnet.stellar.org}"
    PASSPHRASE="${PASSPHRASE:-Public Global Stellar Network ; September 2015}"
    ;;
  *) echo "error: unknown network '$NETWORK' (use testnet or mainnet)" >&2; exit 1 ;;
esac

# ── Build ───────────────────────────────────────────────────────────────────

if [[ "$SKIP_BUILD" != "1" && "$DRY_RUN" != "1" ]]; then
  echo "==> Building WASM (release)"
  cargo build --target wasm32v1-none --release 2>&1
fi

if [[ ! -f "$WASM_PATH" ]]; then
  echo "error: WASM artifact not found at $WASM_PATH" >&2
  exit 1
fi

WASM_SHA="$(sha256sum "$WASM_PATH" | awk '{print $1}')"
echo "WASM SHA-256: 0x${WASM_SHA}"

# ── Provenance attestation verification ─────────────────────────────────────
# Verifies that the WASM artifact was produced by a trusted GitHub Actions
# workflow. Runs before the mainnet gate so unverified artifacts never reach
# promotion. Mainnet deployments always require a verified attestation.

if [[ "$NETWORK" == "mainnet" ]]; then
  REQUIRE_ATTESTATION=1
fi

if [[ "$REQUIRE_ATTESTATION" == "1" ]]; then
  need "$GH_BIN"
  ATTESTATION_ARGS=(attestation verify "$WASM_PATH")
  if [[ -n "$ATTESTATION_REPO" ]]; then
    ATTESTATION_ARGS+=(--repo "$ATTESTATION_REPO")
  fi
  if [[ -n "$ATTESTATION_SIGNER_WORKFLOW" ]]; then
    ATTESTATION_ARGS+=(--signer-workflow "$ATTESTATION_SIGNER_WORKFLOW")
  fi
  echo "==> Verifying build provenance attestation for $WASM_PATH"
  if ! "$GH_BIN" "${ATTESTATION_ARGS[@]}" 2>&1; then
    echo "error: no verified provenance attestation found for $WASM_PATH" >&2
    echo "       refusing to promote an artifact with unverified provenance" >&2
    exit 1
  fi
  echo "Provenance attestation verified"
fi

if [[ "$NETWORK" == "mainnet" && "$DRY_RUN" != "1" ]]; then
  need node
  for gate_input in "$MAINNET_GATE_FILE" "$TESTNET_MANIFEST" "$AUDIT_REPORT"; do
    if [[ -z "$gate_input" || ! -f "$gate_input" ]]; then
      echo "error: mainnet deployment requires --mainnet-gate, --testnet-manifest, and --audit-report files" >&2
      exit 1
    fi
  done
  node "$ROOT_DIR/../../scripts/verify-mainnet-deployment-gate.js" \
    --gate "$MAINNET_GATE_FILE" \
    --testnet-manifest "$TESTNET_MANIFEST" \
    --audit-report "$AUDIT_REPORT" \
    --wasm "$WASM_PATH"
fi

# ── Deploy freeze gate ──────────────────────────────────────────────────────
# Only consulted on real promotion paths; dry runs skip the gate entirely.

if [[ "$DRY_RUN" != "1" ]]; then
  need curl
  FREEZE_ENDPOINT="${DEPLOY_FREEZE_URL%/}/api/v1/deploy-freeze/${NETWORK}"
  FREEZE_RESPONSE="$(curl -fsS --max-time 10 "$FREEZE_ENDPOINT" 2>/dev/null || true)"
  if [[ -z "$FREEZE_RESPONSE" ]]; then
    echo "error: could not read deploy-freeze state from $FREEZE_ENDPOINT" >&2
    exit 1
  fi
  FREEZE_STATE="$(printf '%s' "$FREEZE_RESPONSE" | python3 -c 'import json,sys; print(str(json.load(sys.stdin).get("frozen", False)).lower())' 2>/dev/null || true)"
  if [[ "$FREEZE_STATE" != "true" && "$FREEZE_STATE" != "false" ]]; then
    echo "error: malformed deploy-freeze response from $FREEZE_ENDPOINT" >&2
    exit 1
  fi

  if [[ "$FREEZE_STATE" == "true" ]]; then
    if [[ "$FREEZE_OVERRIDE" != "1" ]]; then
      echo "error: deploy freeze is active for '$NETWORK'; promotion blocked (use --freeze-override with --override-actor and --override-reason to bypass)" >&2
      exit 1
    fi
    echo "==> Deploy freeze active for '$NETWORK'; recording authorized override"
    OVERRIDE_PAYLOAD="$(python3 -c 'import json,sys; print(json.dumps({"actor": sys.argv[1], "reason": sys.argv[2]}))' "$OVERRIDE_ACTOR" "$OVERRIDE_REASON")"
    if ! curl -fsS --max-time 10 -X POST \
      -H 'Content-Type: application/json' \
      -d "$OVERRIDE_PAYLOAD" \
      "${FREEZE_ENDPOINT}/override" >/dev/null 2>&1; then
      echo "error: failed to record deploy-freeze override; refusing to promote" >&2
      exit 1
    fi
    FREEZE_OVERRIDE_RECORDED="true"
  fi
fi

if [[ "$DRY_RUN" == "1" ]]; then
  # Generate a dry-run manifest with placeholder values
  TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  mkdir -p "$OUT_DIR"

  python3 - "$OUT_DIR" <<PY
import json, os, sys
from pathlib import Path
out = Path(sys.argv[1])
manifest = {
    "manifest_version": 1,
    "application": "quickex",
    "generated_at": "$TIMESTAMP",
    "network": "$NETWORK",
    "network_passphrase": "$PASSPHRASE",
    "rpc_url": "$RPC_URL",
    "ledger_sequence": 0,
    "operator": "$SOURCE",
    "contracts": [
        {
            "name": "quickex",
            "contract_id": "DRY_RUN_NOT_DEPLOYED",
            "wasm_hash": "0x${WASM_SHA}",
            "contract_version": 1,
            "event_schema_version": 2,
            "admin_addresses": ["$ADMIN"],
            "init_params": {"admin": "$ADMIN"},
            "deployed_at": "$TIMESTAMP",
            "deployed_by": "$SOURCE",
            "notes": "DRY RUN — no on-chain transactions submitted",
        }
    ],
}
(out / "deployment-manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
PY
  echo "Dry-run manifest written to $OUT_DIR/deployment-manifest.json"
  exit 0
fi

# ── Deploy ──────────────────────────────────────────────────────────────────

DEPLOY_DIR="${OUT_DIR}/${NETWORK}-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DEPLOY_DIR"

echo "==> Installing WASM"
INSTALL_OUTPUT=$($STELLAR_BIN contract install \
  --wasm "$WASM_PATH" \
  --source "$SOURCE" \
  --network "$NETWORK" 2>&1)
echo "$INSTALL_OUTPUT"

echo "==> Deploying contract"
DEPLOY_OUTPUT=$($STELLAR_BIN contract deploy \
  --wasm-hash "$WASM_SHA" \
  --source "$SOURCE" \
  --network "$NETWORK" 2>&1)
echo "$DEPLOY_OUTPUT"

# Extract contract ID from deploy output (last line is typically the ID)
CONTRACT_ID=$(echo "$DEPLOY_OUTPUT" | tail -1 | xargs)
if [[ -z "$CONTRACT_ID" || "$CONTRACT_ID" != C* ]]; then
  echo "error: could not parse contract ID from deploy output" >&2
  exit 1
fi
echo "Contract ID: $CONTRACT_ID"

echo "==> Initialising contract"
INIT_OUTPUT=$($STELLAR_BIN contract invoke \
  --id "$CONTRACT_ID" \
  --source "$SOURCE" \
  --network "$NETWORK" \
  -- \
  initialize \
  --admin "$ADMIN" 2>&1)
echo "$INIT_OUTPUT"

echo "==> Fetching deployment metadata"
METADATA=$($STELLAR_BIN contract invoke \
  --id "$CONTRACT_ID" \
  --source "$SOURCE" \
  --network "$NETWORK" \
  -- \
  get_deployment_metadata 2>&1)
echo "$METADATA"

# ── Capture prior deployment slot / image digest ────────────────────────────
# The prior state file records the deployment slot and image digest of the
# last known-healthy revision. It is required to perform an automated
# rollback; without it we can still deploy but cannot restore a prior revision.
PRIOR_SLOT=""
PRIOR_DIGEST=""
if [[ -n "$PRIOR_STATE_FILE" ]]; then
  if [[ ! -f "$PRIOR_STATE_FILE" ]]; then
    echo "error: prior state file not found: $PRIOR_STATE_FILE" >&2
    exit 1
  fi
  PRIOR_SLOT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("slot",""))' "$PRIOR_STATE_FILE")
  PRIOR_DIGEST=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("image_digest",""))' "$PRIOR_STATE_FILE")
  echo "Prior slot:    ${PRIOR_SLOT:-<none>}"
  echo "Prior digest:  ${PRIOR_DIGEST:-<none>}"
fi

# ── Post-deploy readiness check with automated rollback ─────────────────────
# Polls the readiness endpoint (health_check) up to HEALTH_CHECK_ATTEMPTS times.
# On failure, restores the prior revision captured above (scoped to this
# deployment), records old/new digests, and exits non-zero if rollback
# verification also fails.
readiness_ok=0
HEALTH=""
attempt=1
while [[ "$attempt" -le "$HEALTH_CHECK_ATTEMPTS" ]]; do
  echo "==> Health check (attempt ${attempt}/${HEALTH_CHECK_ATTEMPTS})"
  if HEALTH=$($STELLAR_BIN contract invoke \
      --id "$CONTRACT_ID" \
      --source "$SOURCE" \
      --network "$NETWORK" \
      -- \
      health_check 2>&1); then
    echo "Health: $HEALTH"
    readiness_ok=1
    break
  fi
  echo "Health check failed: $HEALTH" >&2
  if [[ "$attempt" -lt "$HEALTH_CHECK_ATTEMPTS" ]]; then
    sleep "$HEALTH_CHECK_INTERVAL"
  fi
  attempt=$((attempt + 1))
done

if [[ "$readiness_ok" != "1" ]]; then
  echo "error: post-deploy health check failed after ${HEALTH_CHECK_ATTEMPTS} attempts" >&2
  if [[ "$ROLLBACK_ENABLED" != "1" ]]; then
    echo "error: rollback disabled (--no-rollback); leaving failed deployment $CONTRACT_ID in place" >&2
    exit 1
  fi
  if [[ -z "$PRIOR_SLOT" || -z "$PRIOR_DIGEST" ]]; then
    echo "error: cannot roll back: no prior deployment slot/digest captured (pass --prior-state)" >&2
    exit 1
  fi

  echo "==> Rolling back failed deployment $CONTRACT_ID to prior revision"
  echo "    old digest (failed):  $WASM_SHA"
  echo "    new digest (restore): $PRIOR_DIGEST"
  echo "    target slot:          $PRIOR_SLOT"

  # Restore the prior revision, scoped to the failed deployment's contract ID.
  if ! ROLLBACK_OUTPUT=$($STELLAR_BIN contract deploy \
      --wasm-hash "$PRIOR_DIGEST" \
      --source "$SOURCE" \
      --network "$NETWORK" 2>&1); then
    echo "ROLLBACK FAILED: could not restore prior revision $PRIOR_DIGEST" >&2
    echo "$ROLLBACK_OUTPUT" >&2
    exit 1
  fi
  echo "$ROLLBACK_OUTPUT"

  # Verify the rollback by re-running the readiness check against the restored
  # revision. If verification fails, fail loudly.
  echo "==> Verifying rollback"
  rollback_ok=0
  attempt=1
  while [[ "$attempt" -le "$HEALTH_CHECK_ATTEMPTS" ]]; do
    if ROLLBACK_HEALTH=$($STELLAR_BIN contract invoke \
        --id "$CONTRACT_ID" \
        --source "$SOURCE" \
        --network "$NETWORK" \
        -- \
        health_check 2>&1); then
      echo "Rollback health: $ROLLBACK_HEALTH"
      rollback_ok=1
      break
    fi
    echo "Rollback health check failed: $ROLLBACK_HEALTH" >&2
    if [[ "$attempt" -lt "$HEALTH_CHECK_ATTEMPTS" ]]; then
      sleep "$HEALTH_CHECK_INTERVAL"
    fi
    attempt=$((attempt + 1))
  done

  if [[ "$rollback_ok" != "1" ]]; then
    echo "ROLLBACK VERIFICATION FAILED: prior revision $PRIOR_DIGEST is not healthy" >&2
    echo "  failed deployment: $CONTRACT_ID" >&2
    echo "  old digest:        $WASM_SHA" >&2
    echo "  new digest:        $PRIOR_DIGEST" >&2
    exit 1
  fi

  echo "Rollback complete: restored $PRIOR_DIGEST (was $WASM_SHA)"
  exit 1
fi

echo "==> Fetching current ledger sequence"
LEDGER_OUTPUT=$($STELLAR_BIN ledger current --network "$NETWORK" 2>&1)
LEDGER_SEQUENCE=$(printf '%s\n' "$LEDGER_OUTPUT" | sed -n 's/.*Current ledger sequence: \([0-9][0-9]*\).*/\1/p' | tail -1)
if [[ -z "$LEDGER_SEQUENCE" ]]; then
  echo "error: could not determine the current ledger sequence; refusing to emit an incomplete manifest" >&2
  exit 1
fi
echo "Ledger Sequence: $LEDGER_SEQUENCE"

# ── Generate manifest ───────────────────────────────────────────────────────

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

python3 - "$DEPLOY_DIR" "$METADATA" "$CONTRACT_ID" "$WASM_SHA" "$TIMESTAMP" "$LEDGER_SEQUENCE" "$ADMIN" "$SOURCE" "$NETWORK" "$PASSPHRASE" "$RPC_URL" "$FREEZE_STATE" "$FREEZE_OVERRIDE_RECORDED" "$OVERRIDE_ACTOR" <<'PY'
import json, sys
from pathlib import Path

deploy_dir = Path(sys.argv[1])
metadata_raw = sys.argv[2]
contract_id = sys.argv[3]
wasm_sha = sys.argv[4]
timestamp = sys.argv[5]
ledger_sequence = sys.argv[6]
admin, source, network, passphrase, rpc_url = sys.argv[7:12]
freeze_state = sys.argv[12]
freeze_override_recorded = sys.argv[13] == "true"
override_actor = sys.argv[14]

# Parse on-chain metadata (Soroban CLI returns JSON with string-encoded values)
try:
    meta = json.loads(metadata_raw)
except (json.JSONDecodeError, TypeError):
    meta = {"raw": metadata_raw}

contract_version = meta.get("contract_version", 1)
event_schema_version = meta.get("event_schema_version", 2)

# Build manifest with sorted keys for stable output
manifest = {
    "manifest_version": 1,
    "application": "quickex",
    "generated_at": timestamp,
    "network": network,
    "network_passphrase": passphrase,
    "rpc_url": rpc_url,
    "ledger_sequence": int(ledger_sequence),
    "operator": source,
    "contracts": [
        {
            "name": "quickex",
            "contract_id": contract_id,
            "wasm_hash": "0x" + wasm_sha if not wasm_sha.startswith("0x") else wasm_sha,
            "contract_version": contract_version,
            "event_schema_version": event_schema_version,
            "admin_addresses": [admin],
            "init_params": {"admin": admin},
            "deployed_at": timestamp,
            "deployed_by": source,
        }
    ],
    "deploy_freeze": {
        "frozen_at_promotion": freeze_state == "true",
        "override_recorded": freeze_override_recorded,
        "override_actor": override_actor if freeze_override_recorded else None,
    },
}

manifest_path = deploy_dir / "deployment-manifest.json"
manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
print(f"Manifest written to {manifest_path}")

# Also write latest symlink copy
latest_dir = deploy_dir.parent / "latest"
latest_dir.mkdir(parents=True, exist_ok=True)
latest_path = latest_dir / "deployment-manifest.json"
latest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
print(f"Latest manifest symlink: {latest_path}")
PY

echo ""
echo "=== Deployment Complete ==="
echo "Network:       $NETWORK"
echo "Contract ID:   $CONTRACT_ID"
echo "WASM Hash:     0x${WASM_SHA}"
echo "Admin:         $ADMIN"
echo "Operator:      $SOURCE"
echo "Freeze state:  $FREEZE_STATE"
if [[ "$FREEZE_OVERRIDE_RECORDED" == "true" ]]; then
  echo "Override:      authorized by $OVERRIDE_ACTOR (recorded)"
fi
echo "Manifest:      $DEPLOY_DIR/deployment-manifest.json"
if [[ -n "$PRIOR_DIGEST" ]]; then
  echo "Prior digest:  $PRIOR_DIGEST"
fi
echo "New digest:    $WASM_SHA"
