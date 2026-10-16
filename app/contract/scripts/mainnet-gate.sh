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

FAILED=0

fail() {
  echo "FAIL: $1" >&2
  FAILED=1
}

pass() {
  echo "PASS: $1"
}

# --- Gate 1: cargo test passes with 0 failures -------------------------------
echo "==> [1/5] cargo test"
if (cd "${CONTRACT_DIR}" && cargo test --workspace); then
  pass "cargo test"
else
  fail "cargo test did not pass (see output above)"
fi

# --- Gate 2: cargo clippy -- -D warnings -------------------------------------
echo "==> [2/5] cargo clippy -- -D warnings"
if (cd "${CONTRACT_DIR}" && cargo clippy --workspace --all-targets -- -D warnings); then
  pass "cargo clippy"
else
  fail "cargo clippy reported warnings/errors"
fi

# --- Gate 3: cargo audit, no active advisories with CVSS >= 7.0 --------------
echo "==> [3/5] cargo audit (CVSS >= 7.0)"
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
echo "==> [4/5] contract version vs deployed version"
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
echo "==> [5/5] mainnet.* feature flags"
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

# --- Result ------------------------------------------------------------------
echo ""
if [ "${FAILED}" -ne 0 ]; then
  echo "MAINNET GATE FAILED: one or more checks did not pass." >&2
  exit 1
fi

echo "MAINNET GATE PASSED: all checks satisfied."
exit 0
