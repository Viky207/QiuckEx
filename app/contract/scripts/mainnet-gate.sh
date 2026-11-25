#!/usr/bin/env bash
#
# Mainnet deployment gate.
#
# Automates the manual checks in app/contract/MAINNET_DEPLOYMENT_CHECKLIST.md.
# Exits 0 only when every gate passes; otherwise exits non-zero and prints
# which check failed.
#
# Usage: app/contract/scripts/mainnet-gate.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${CONTRACT_DIR}/../.." && pwd)"

DEPLOYED_VERSION_FILE="${CONTRACT_DIR}/deployed-version.txt"
FEATURE_FLAGS_DIR="${REPO_ROOT}/app/backend/src/feature-flags"

# Deploy freeze switch. When the freeze marker file exists, mainnet promotion is
# blocked unless an auditable override is supplied via the environment:
#   DEPLOY_FREEZE_OVERRIDE_ACTOR   - identity of the operator granting override
#   DEPLOY_FREEZE_OVERRIDE_REASON  - justification for bypassing the freeze
# Overrides are appended to the audit log (never containing secrets).
DEPLOY_FREEZE_FILE="${DEPLOY_FREEZE_FILE:-${CONTRACT_DIR}/deploy-freeze}"
DEPLOY_FREEZE_AUDIT_LOG="${DEPLOY_FREEZE_AUDIT_LOG:-${CONTRACT_DIR}/deploy-freeze-audit.log}"

# Post-deploy health check / rollback configuration.
# The readiness endpoint is polled until it reports healthy or the timeout
# elapses; on failure the rollback path in deploy.sh is invoked using the
# recorded prior digest, then readiness is re-checked.
HEALTH_URL="${MAINNET_GATE_HEALTH_URL:-http://127.0.0.1:8080/health/ready}"
HEALTH_TIMEOUT_SECONDS="${MAINNET_GATE_HEALTH_TIMEOUT:-60}"
HEALTH_INTERVAL_SECONDS="${MAINNET_GATE_HEALTH_INTERVAL:-5}"
DEPLOY_SCRIPT="${CONTRACT_DIR}/scripts/deploy.sh"
ROLLBACK_STATE_FILE="${CONTRACT_DIR}/.rollback-state.json"

FAILED=0

# Digests recorded for the gate summary (populated by the health-check step).
OLD_DIGEST=""
NEW_DIGEST=""
ROLLBACK_PERFORMED="no"
=======

fail() {
  echo "FAIL: $1" >&2
  FAILED=1
}

pass() {
  echo "PASS: $1"
}

# --- Gate 0: deploy freeze switch -------------------------------------------
# A hold prevents production traffic changes. Clearing the hold resumes only
# new eligible runs; it never retroactively unblocks a failed gate.
echo "==> [0/7] deploy freeze"
if [ ! -e "${DEPLOY_FREEZE_FILE}" ]; then
  pass "no deploy freeze active"
else
  OVERRIDE_ACTOR="${DEPLOY_FREEZE_OVERRIDE_ACTOR:-}"
  OVERRIDE_REASON="${DEPLOY_FREEZE_OVERRIDE_REASON:-}"
  if [ -z "${OVERRIDE_ACTOR}" ] || [ -z "${OVERRIDE_REASON}" ]; then
    fail "deploy freeze active (${DEPLOY_FREEZE_FILE}); promotion blocked. Set DEPLOY_FREEZE_OVERRIDE_ACTOR and DEPLOY_FREEZE_OVERRIDE_REASON to override."
  else
    TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if ! printf '%s\tactor=%s\treason=%s\n' "${TIMESTAMP}" "${OVERRIDE_ACTOR}" "${OVERRIDE_REASON}" >> "${DEPLOY_FREEZE_AUDIT_LOG}" 2>/dev/null; then
      fail "deploy freeze override could not be recorded in ${DEPLOY_FREEZE_AUDIT_LOG}; refusing to proceed"
    else
      pass "deploy freeze overridden by ${OVERRIDE_ACTOR} (logged to ${DEPLOY_FREEZE_AUDIT_LOG})"
    fi
  fi
fi

# --- Gate 1: cargo test passes with 0 failures -------------------------------
echo "==> [1/7] cargo test"
if (cd "${CONTRACT_DIR}" && cargo test --workspace); then
  pass "cargo test"
else
  fail "cargo test did not pass (see output above)"
fi

# --- Gate 2: cargo clippy -- -D warnings -------------------------------------
echo "==> [2/7] cargo clippy -- -D warnings"
if (cd "${CONTRACT_DIR}" && cargo clippy --workspace --all-targets -- -D warnings); then
  pass "cargo clippy"
else
  fail "cargo clippy reported warnings/errors"
fi

# --- Gate 3: cargo audit, no active advisories with CVSS >= 7.0 --------------
echo "==> [3/7] cargo audit (CVSS >= 7.0)"
if ! command -v cargo-audit >/dev/null 2>&1; then
  fail "cargo-audit is not installed; cannot verify advisories"
else
  AUDIT_JSON="$(cd "${CONTRACT_DIR}" && cargo audit --json 2>/dev/null)"
  if [ -z "${AUDIT_JSON}" ]; then
    fail "cargo audit produced no output"
  else
    HIGH_ADVISORIES="$(printf '%s' "${AUDIT_JSON}" | python3 -c '
import json, sys

try:
    data = json.load(sys.stdin)
except Exception:
    print("PARSE_ERROR")
    sys.exit(0)

high = []
for vuln in data.get("vulnerabilities", {}).get("list", []):
    advisory = vuln.get("advisory", {})
    cvss = advisory.get("cvss")
    if cvss is None:
        continue
    try:
        score = float(cvss)
    except (TypeError, ValueError):
        continue
    if score >= 7.0:
        high.append("%s (%s, CVSS %s)" % (advisory.get("id", "?"), advisory.get("title", "?"), score))

for item in high:
    print(item)
')"
    if [ "${HIGH_ADVISORIES}" = "PARSE_ERROR" ]; then
      fail "could not parse cargo audit output"
    elif [ -n "${HIGH_ADVISORIES}" ]; then
      fail "cargo audit found active advisories with CVSS >= 7.0:"
      printf '%s\n' "${HIGH_ADVISORIES}" >&2
    else
      pass "cargo audit (no advisories with CVSS >= 7.0)"
    fi
  fi
fi

# --- Gate 4: contract version higher than last deployed version --------------
echo "==> [4/7] contract version vs deployed version"
CURRENT_VERSION="$(cd "${CONTRACT_DIR}" && cargo metadata --no-deps --format-version 1 2>/dev/null | python3 -c '
import json, sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

for pkg in data.get("packages", []):
    if pkg.get("name") == "quickex":
        print(pkg.get("version", ""))
        break
')"

if [ -z "${CURRENT_VERSION}" ]; then
  fail "could not determine contract version from Cargo.toml"
elif [ ! -f "${DEPLOYED_VERSION_FILE}" ]; then
  fail "missing deployed version file: ${DEPLOYED_VERSION_FILE}"
else
  DEPLOYED_VERSION="$(tr -d '[:space:]' < "${DEPLOYED_VERSION_FILE}")"
  if [ -z "${DEPLOYED_VERSION}" ]; then
    fail "deployed version file is empty: ${DEPLOYED_VERSION_FILE}"
  else
    HIGHER="$(python3 -c '
import sys

def parse(v):
    parts = []
    for chunk in v.split("."):
        num = ""
        for ch in chunk:
            if ch.isdigit():
                num += ch
            else:
                break
        parts.append(int(num) if num else 0)
    return parts

current = parse(sys.argv[1])
deployed = parse(sys.argv[2])
length = max(len(current), len(deployed))
current += [0] * (length - len(current))
deployed += [0] * (length - len(deployed))
print("yes" if current > deployed else "no")
' "${CURRENT_VERSION}" "${DEPLOYED_VERSION}")"
    if [ "${HIGHER}" = "yes" ]; then
      pass "contract version ${CURRENT_VERSION} > deployed ${DEPLOYED_VERSION}"
    else
      fail "contract version ${CURRENT_VERSION} is not higher than deployed ${DEPLOYED_VERSION}"
    fi
  fi
fi

# --- Gate 5: mainnet.* feature flags verified against backend ---------------
echo "==> [5/7] mainnet.* feature flags"
if [ ! -d "${FEATURE_FLAGS_DIR}" ]; then
  fail "feature flags directory not found: ${FEATURE_FLAGS_DIR}"
else
  UNVERIFIED="$(grep -rhoE 'mainnet\.[A-Za-z0-9_.-]+' "${CONTRACT_DIR}" --include='*.rs' --include='*.toml' 2>/dev/null | sort -u | while read -r flag; do
    if ! grep -rqF "${flag}" "${FEATURE_FLAGS_DIR}" 2>/dev/null; then
      echo "${flag}"
    fi
  done)"
  if [ -n "${UNVERIFIED}" ]; then
    fail "mainnet.* feature flags not found in ${FEATURE_FLAGS_DIR}:"
    printf '%s\n' "${UNVERIFIED}" >&2
  else
    pass "all mainnet.* feature flags verified"
  fi
fi

# --- Gate 6: post-deploy health check with automated rollback ---------------
echo "==> [6/7] post-deploy health check"

# Poll the readiness endpoint until healthy or the timeout elapses.
check_readiness() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if curl -fsS --max-time 5 "${HEALTH_URL}" >/dev/null 2>&1; then
      return 0
    fi
    sleep "${HEALTH_INTERVAL_SECONDS}"
  done
  return 1
}

# Read the recorded old/new digests from the rollback state file, if present.
read_rollback_state() {
  if [ ! -f "${ROLLBACK_STATE_FILE}" ]; then
    return 0
  fi
  local parsed
  parsed="$(python3 -c '
import json, sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        data = json.load(fh)
except Exception:
    sys.exit(0)

print(data.get("old_digest", ""))
print(data.get("new_digest", ""))
' "${ROLLBACK_STATE_FILE}" 2>/dev/null)"
  if [ -n "${parsed}" ]; then
    OLD_DIGEST="$(printf '%s\n' "${parsed}" | sed -n '1p')"
    NEW_DIGEST="$(printf '%s\n' "${parsed}" | sed -n '2p')"
  fi
}

read_rollback_state

if [ ! -f "${DEPLOY_SCRIPT}" ]; then
  fail "deploy script not found: ${DEPLOY_SCRIPT}; cannot verify or roll back deployment"
elif check_readiness; then
  pass "post-deploy health check (${HEALTH_URL})"
else
  fail "post-deploy health check failed (${HEALTH_URL}); attempting rollback"
  if [ -z "${OLD_DIGEST}" ]; then
    fail "no recorded prior digest available; cannot roll back safely"
  else
    echo "==> rolling back to prior digest ${OLD_DIGEST} (failed digest ${NEW_DIGEST:-unknown})"
    if bash "${DEPLOY_SCRIPT}" rollback --to-digest "${OLD_DIGEST}"; then
      ROLLBACK_PERFORMED="yes"
      if check_readiness; then
        pass "rollback restored health at prior digest ${OLD_DIGEST}"
      else
        fail "ROLLBACK VERIFICATION FAILED: health check still failing after rollback to ${OLD_DIGEST}"
      fi
    else
      fail "ROLLBACK FAILED: deploy.sh rollback to ${OLD_DIGEST} did not succeed"
    fi
  fi
fi

# --- Result ------------------------------------------------------------------
echo ""
echo "Deployment digests:"
echo "  old: ${OLD_DIGEST:-<none recorded>}"
echo "  new: ${NEW_DIGEST:-<none recorded>}"
echo "  rollback performed: ${ROLLBACK_PERFORMED}"
echo ""
if [ "${FAILED}" -ne 0 ]; then
  echo "MAINNET GATE FAILED: one or more checks did not pass." >&2
  exit 1
fi

echo "MAINNET GATE PASSED: all checks satisfied."
exit 0
