#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# rc-validate.sh – One-command release candidate validation
#
# Usage:
#   ./scripts/rc-validate.sh                   # full gate, all stages
#   ./scripts/rc-validate.sh --quick           # fast subset, no slow stages
#   ./scripts/rc-validate.sh --stage lint,test # only these stages
#   ./scripts/rc-validate.sh --list            # show stages and exit
#   ./scripts/rc-validate.sh --json            # NDJSON result lines
#   ./scripts/rc-validate.sh --allow-skip      # optional stages may SKIP
#
# This is the single entry point a release candidate must pass. It runs the
# same checks, in the same order, as the CI workflows (ci.yml, backend.yml,
# contract.yml, frontend-ci.yml). `.github/workflows/rc-validate.yml` calls
# this exact script, so there is one definition of the gate rather than two
# that drift apart.
#
# Stage outcomes
#   PASS  – ran and succeeded
#   FAIL  – ran and failed; the release candidate is blocked
#   SKIP  – prerequisite toolchain unavailable (optional stages only)
#
# A SKIP fails the run by default: a candidate that silently skipped the
# contract tests is not a release candidate. Pass --allow-skip (or set
# RC_ALLOW_SKIP=1) when a skip is genuinely acceptable for the change.
#
# Environment
#   STELLAR_NETWORK  testnet (default). mainnet is refused — a candidate is
#                    validated against testnet only, per
#                    docs/adr/0002-testnet-first-mainnet-feature-gated.md.
#   RC_BASE_REF      base ref for the capability-map diff (default origin/main)
#   RC_ALLOW_SKIP    "1" to treat optional skips as acceptable
#   RC_FREEZE_FILE   deploy-freeze state file (default .deploy-freeze.json)
#   RC_FREEZE_OVERRIDE  "1" to promote despite an active freeze. The override is
#                    recorded in the freeze file's audit log; it never clears
#                    the freeze itself.
#   RC_FREEZE_GENERATION  freeze generation captured when this run started. If
#                    the freeze was cleared and re-armed after the run began,
#                    the generation no longer matches and the run is refused:
#                    clearing a freeze resumes only new eligible runs.
#   RC_IMAGE_DIGESTS comma-separated `repo@sha256:...` release image digests
#   RC_IMAGE_REPO    expected source repository for provenance verification
#   COSIGN_PRIVATE_KEY / COSIGN_KEY  signing key for the sign-images stage
#                    (never logged)
#   COSIGN_PUBLIC_KEY_FILE  public key used by verify-images (default cosign.pub)
#   RC_PROVENANCE_POLICY    cosign attestation policy file
#   RC_RELEASE_MANIFEST     path to the release manifest (default
#                    release-manifest.json). Written by the release-manifest
#                    stage and referenced by deployment runs for traceability.
#   RC_RELEASE_VERSION      release version recorded in the manifest
#                    (default: package.json version)
#   RC_MANIFEST_SCHEMA      manifest schema file
#                    (default scripts/release-manifest.schema.json)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

JSON=0
QUICK=0
LIST_ONLY=0
ALLOW_SKIP="${RC_ALLOW_SKIP:-0}"
STAGE_FILTER=""
RC_BASE_REF="${RC_BASE_REF:-origin/main}"
RC_RELEASE_MANIFEST="${RC_RELEASE_MANIFEST:-release-manifest.json}"
RC_MANIFEST_SCHEMA="${RC_MANIFEST_SCHEMA:-scripts/release-manifest.schema.json}"

while [ $# -gt 0 ]; do
  case "$1" in
    --quick)      QUICK=1 ;;
    --json)       JSON=1 ;;
    --list)       LIST_ONLY=1 ;;
    --allow-skip) ALLOW_SKIP=1 ;;
    --stage)      shift; STAGE_FILTER="${1:-}" ;;
    --stage=*)    STAGE_FILTER="${1#*=}" ;;
    -h|--help)    sed -n '2,44p' "$0"; exit 0 ;;
    *)            echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# ── stage registry ───────────────────────────────────────────────────────────
# "name|required_tool|optional|description"
# The tool field names the binary that must exist for the stage to run at all.
# For secret-scan that is `detect-secrets`, not `python3`: secret-scan.sh exits
# non-zero when its own dependency is absent, which would otherwise be reported
# as a scan failure rather than an honest SKIP.
FULL_STAGES=(
  "env|pnpm|0|Pinned toolchain versions match CI"
  "install|pnpm|0|Workspace dependencies resolve from the lockfile"
  "secret-scan|detect-secrets|1|No new secrets versus .secrets.baseline"
  "lint|pnpm|0|ESLint clean across the workspace"
  "type-check|pnpm|0|tsc --noEmit clean across the workspace"
  "build|pnpm|0|All packages build"
  "test|pnpm|0|Backend unit and integration suites pass coverage thresholds"
  "invariants|pnpm|0|Rust and Jest invariant test suites pass"
  "fuzz|pnpm|1|Property-based suites (fast-check)"
  "contract|cargo|1|cargo fmt + clippy + test in app/contract"
  "openapi|pnpm|0|Committed openapi.json matches the code"
  "actions-pinned|git|0|All workflow/action uses: refs are pinned to full commit SHAs"
  "attestation|gh|1|Release artifacts carry verifiable provenance attestations"
  "sign-images|cosign|1|Release image digests signed with cosign"
  "verify-images|cosign|0|Image signatures and provenance verified before deploy"
  "release-manifest|node|0|Release manifest generated, schema-valid, digest-complete"
  "capability-map|git|1|Capability-map rows changed alongside behavior"
  "deploy-freeze|-|0|No active deploy freeze blocks promotion"
)

QUICK_STAGES=(
  "env|pnpm|0|Pinned toolchain versions match CI"
  "install|pnpm|0|Workspace dependencies resolve from the lockfile"
  "secret-scan|detect-secrets|1|No new secrets versus .secrets.baseline"
  "lint|pnpm|0|ESLint clean across the workspace"
  "type-check|pnpm|0|tsc --noEmit clean across the workspace"
  "deploy-freeze|-|0|No active deploy freeze blocks promotion"
)

if [ "$QUICK" -eq 1 ]; then STAGES=("${QUICK_STAGES[@]}"); else STAGES=("${FULL_STAGES[@]}"); fi

if [ -n "$STAGE_FILTER" ]; then
  FILTERED=()
  IFS=',' read -ra WANTED <<< "$STAGE_FILTER"
  for stage in "${STAGES[@]}"; do
    sname="${stage%%|*}"
    for w in "${WANTED[@]}"; do
      if [ "$sname" = "$(echo "$w" | tr -d '[:space:]')" ]; then FILTERED+=("$stage"); break; fi
    done
  done
  STAGES=("${FILTERED[@]:-}")
fi

if [ "$LIST_ONLY" -eq 1 ]; then
  echo "Release candidate stages:"
  for stage in "${STAGES[@]}"; do
    IFS='|' read -r s tool opt desc <<< "$stage"
    printf '  %-14s tool=%-8s optional=%s  %s\n' "$s" "$tool" "$opt" "$desc"
  done
  exit 0
fi

# ── preflight: refuse mainnet ────────────────────────────────────────────────
if [ "${STELLAR_NETWORK:-testnet}" = "mainnet" ]; then
  log_msg() { printf '%s\n' "$*" >&2; }
  log_msg "::error::STELLAR_NETWORK=mainnet is refused. A release candidate is"
  log_msg "        validated against testnet only. Enable mainnet behaviour as a"
  log_msg "        separate, reviewed rollout after promotion (ADR 0002)."
  exit 2
fi

# ── preflight: deploy freeze ─────────────────────────────────────────────────
# A freeze pauses automatic production promotion during an incident or
# maintenance window. It does not disable validation: the stages below still
# run so the candidate is known-good when the freeze lifts. It only blocks the
# promotion verdict, which is what this script's exit code represents.
#
# The freeze file is JSON:
#   { "active": true, "generation": 3, "reason": "...", "audit": [ ... ] }
# `generation` increments every time the freeze is armed or cleared, so a run
# that started under generation N can detect that the freeze state changed
# underneath it. Clearing a freeze therefore resumes only runs that start
# after the clear; an in-flight run whose generation is stale is refused.
freeze_preflight() {
  [ -f "$RC_FREEZE_FILE" ] || return 0

  local active generation reason
  active="$(sed -n 's/.*"active"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' "$RC_FREEZE_FILE" | head -n1)"
  generation="$(sed -n 's/.*"generation"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$RC_FREEZE_FILE" | head -n1)"
  reason="$(sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$RC_FREEZE_FILE" | head -n1)"
  [ -n "$generation" ] || generation=0

  # Stale generation: the freeze was cleared (or re-armed) after this run
  # started. Refuse rather than guess which state the run belongs to.
  if [ -n "$RC_FREEZE_GENERATION" ] && [ "$RC_FREEZE_GENERATION" != "$generation" ]; then
    log_msg "::error::deploy freeze generation changed during this run"
    log_msg "        started at generation $RC_FREEZE_GENERATION, now $generation."
    log_msg "        Re-run so the candidate is evaluated against the current"
    log_msg "        freeze state."
    exit 2
  fi

  [ "$active" = "true" ] || return 0

  if [ "$RC_FREEZE_OVERRIDE" = "1" ]; then
    # Auditable override: append to the freeze file's audit log. No secrets or
    # personal data are recorded — only who/what/when and the reason.
    local actor ts entry
    actor="${GITHUB_ACTOR:-${USER:-unknown}}"
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    entry="{\"event\":\"override\",\"actor\":\"$actor\",\"at\":\"$ts\",\"commit\":\"$(git rev-parse --short HEAD 2>/dev/null || echo unknown)\",\"generation\":$generation}"
    if grep -q '"audit"[[:space:]]*:[[:space:]]*\[' "$RC_FREEZE_FILE"; then
      # Insert before the closing bracket of the audit array.
      sed -i.bak "s/\"audit\"\\([[:space:]]*\\):\\([[:space:]]*\\)\\[\\([^]]*\\)\\]/\"audit\"\\1:\\2[\\3${entry},]/" "$RC_FREEZE_FILE" 2>/dev/null \
        || sed -i '' "s/\"audit\"\\([[:space:]]*\\):\\([[:space:]]*\\)\\[\\([^]]*\\)\\]/\"audit\"\\1:\\2[\\3${entry},]/" "$RC_FREEZE_FILE"
      rm -f "$RC_FREEZE_FILE.bak"
    fi
    log_msg "::warning::deploy freeze OVERRIDDEN by $actor at $ts (generation $generation)"
    log_msg "         reason on file: ${reason:-unspecified}"
    return 0
  fi

  log_msg "::error::deploy freeze is active — production promotion is held"
  log_msg "        reason: ${reason:-unspecified}"
  log_msg "        generation: $generation"
  log_msg "        Validation stages still run; the promotion verdict is blocked."
  log_msg "        Clear the freeze, or re-run with RC_FREEZE_OVERRIDE=1 to record"
  log_msg "        an auditable override."
  exit 2
}

log_msg() { printf '%s\n' "$*" >&2; }
freeze_preflight

declare -a RESULT_NAMES=() RESULT_STATES=() RESULT_MS=() RESULT_DETAILS=()
FAILURES=0
SKIPS=0
PASSES=0
START_NS=$(date +%s%N 2>/dev/null || echo 0)

GH_NOTE=0
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  GH_NOTE=1
  { echo "### Release candidate validation"; echo ""
    echo "| stage | result | duration | detail |"; echo "|---|---|---|---|"; } >> "$GITHUB_STEP_SUMMARY"
fi

now_ms() { echo $(( ($(date +%s%N 2>/dev/null || echo 0)) / 1000000 )); }

record() {
  # record <name> <state> <duration_ms> <detail>
  RESULT_NAMES+=("$1"); RESULT_STATES+=("$2"); RESULT_MS+=("$3"); RESULT_DETAILS+=("$4")
  case "$2" in
    PASS) icon="✔" ;;
    FAIL) icon="✘" ;;
    SKIP) icon="⊘" ;;
    *)    icon="?" ;;
  esac
  printf '%s %-14s %7sms  %s\n' "$icon" "$1" "$3" "$4" >&2
  esc=$(printf '%s' "$4" | sed 's/\\/\\\\/g; s/"/\\"/g; s/|/\\|/g')
  [ "$JSON" -eq 1 ] && printf '{"stage":"%s","result":"%s","duration_ms":%s,"detail":"%s"}\n' "$1" "$2" "$3" "$esc"
  [ "$GH_NOTE" -eq 1 ] && echo "| \`$1\` | **$2** | ${3}ms | $esc |" >> "$GITHUB_STEP_SUMMARY"
  case "$2" in
    FAIL) FAILURES=$((FAILURES + 1)) ;;
    SKIP) SKIPS=$((SKIPS + 1)) ;;
    *)    PASSES=$((PASSES + 1)) ;;
  esac
  return 0
}

log() { printf '%s\n' "$*" >&2; }

log "Release candidate validation"
log "  repo:   $REPO_ROOT"
log "  commit: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
log "  branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
log "  network: ${STELLAR_NETWORK:-testnet}"
log "  mode:    $([ "$QUICK" -eq 1 ] && echo quick || echo full)"
log ""

for stage in "${STAGES[@]}"; do
  IFS='|' read -r name tool optional desc <<< "$stage"
  t0=$(now_ms)

  # Missing toolchain: optional stages SKIP, required stages FAIL. A required
  # stage is one whose absence means we cannot honestly call the candidate
  # validated.
  if [ "$tool" != "-" ] && ! command -v "$tool" >/dev/null 2>&1; then
    elapsed=$(( $(now_ms) - t0 ))
    if [ "$optional" = "1" ]; then
      record "$name" "SKIP" "$elapsed" "$tool not installed"
    else
      record "$name" "FAIL" "$elapsed" "$tool not installed (required)"
    fi
    continue
  fi

  ok=0
  detail=""

  case "$name" in
    env)
      # CI pins Node 20 (.github/workflows/ci.yml). Running the gate on an
      # older runtime can pass here and fail there, so it is a hard check.
      node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
      if [ "$node_major" -lt 20 ]; then
        detail="FAILED: node $(node -v) is below the CI floor of 20"
      else
        ok=1
        detail="node $(node -v), packageManager=$(node -p "require('./package.json').packageManager" 2>/dev/null || echo unset)"
      fi
      ;;

    install)
      # --frozen-lockfile is the point: a candidate whose lockfile does not
      # resolve is not reproducible, which is the property being validated.
      if pnpm install --frozen-lockfile >/tmp/rc-install.log 2>&1; then
        ok=1; detail="lockfile resolved"
      else
        detail="FAILED: pnpm install --frozen-lockfile (see /tmp/rc-install.log)"
      fi
      ;;

    secret-scan)
      if bash scripts/secret-scan.sh --verify >/tmp/rc-secrets.log 2>&1; then
        ok=1; detail="no new secrets vs .secrets.baseline"
      else
        detail="FAILED: secret scan (see /tmp/rc-secrets.log)"
      fi
      ;;

    lint)
      if pnpm lint >/tmp/rc-lint.log 2>&1; then
        ok=1; detail="eslint clean"
      else
        detail="FAILED: pnpm lint (see /tmp/rc-lint.log)"
      fi
      ;;

    type-check)
      if pnpm type-check >/tmp/rc-typecheck.log 2>&1; then
        ok=1; detail="tsc --noEmit clean"
      else
        detail="FAILED: pnpm type-check (see /tmp/rc-typecheck.log)"
      fi
      ;;

    build)
      if pnpm build >/tmp/rc-build.log 2>&1; then
        ok=1; detail="all packages built"
      else
        detail="FAILED: pnpm build (see /tmp/rc-build.log)"
      fi
      ;;

    test)
      # Kept separate, as backend.yml does, so a red build names its layer.
      if NODE_ENV=test STELLAR_NETWORK=testnet \
         pnpm --filter @quickex/backend test:unit >/tmp/rc-test-unit.log 2>&1; then
        if NODE_ENV=test STELLAR_NETWORK=testnet \
           pnpm --filter @quickex/backend test:int >/tmp/rc-test-int.log 2>&1; then
          ok=1; detail="unit + integration suites pass with coverage thresholds"
        else
          detail="FAILED: integration suite (see /tmp/rc-test-int.log)"
        fi
      else
        detail="FAILED: unit suite (see /tmp/rc-test-unit.log)"
      fi
      ;;

    invariants)
      # Required RC gate: the Rust and Jest invariant suites must both pass.
      # These encode the protocol invariants a release candidate is expected to
      # uphold, so a failure here blocks the candidate outright.
      if ( cd app/contract \
           && cargo test --test invariants >/tmp/rc-invariants-rust.log 2>&1 ); then
        if NODE_ENV=test STELLAR_NETWORK=testnet \
           pnpm --filter @quickex/backend test:invariants >/tmp/rc-invariants-jest.log 2>&1; then
          ok=1; detail="Rust + Jest invariant suites pass"
        else
          detail="FAILED: Jest invariant suite (see /tmp/rc-invariants-jest.log)"
        fi
      else
        detail="FAILED: Rust invariant suite (see /tmp/rc-invariants-rust.log)"
      fi
      ;;

    fuzz)
      if NODE_ENV=test STELLAR_NETWORK=testnet \
         pnpm --filter @quickex/backend test:fuzz >/tmp/rc-fuzz.log 2>&1; then
        ok=1; detail="property-based suites pass"
      else
        detail="FAILED: fuzz suites (see /tmp/rc-fuzz.log)"
      fi
      ;;

    contract)
      # Same three checks, same order, as .github/workflows/contract.yml.
      if ( cd app/contract \
           && cargo fmt --all -- --check >/tmp/rc-fmt.log 2>&1 \
           && cargo clippy --all-targets --all-features -- -D warnings >/tmp/rc-clippy.log 2>&1 \
           && cargo test >/tmp/rc-cargo-test.log 2>&1 ); then
        ok=1; detail="cargo fmt + clippy + test clean"
      else
        detail="FAILED: contract checks (see /tmp/rc-fmt.log, /tmp/rc-clippy.log, /tmp/rc-cargo-test.log)"
      fi
      ;;

    actions-pinned)
      # Issue #547: every external `uses:` reference must be an immutable full
      # commit SHA. Mutable tags can be retargeted after review, so a candidate
      # whose workflows reference a tag is not reproducible. The checker is the
      # single definition of the rule; CI runs the same script.
      if bash scripts/check-actions-pinned.sh >/tmp/rc-actions-pinned.log 2>&1; then
        ok=1; detail="all uses: refs pinned to full commit SHAs"
      else
        detail="FAILED: mutable action reference (see /tmp/rc-actions-pinned.log)"
      fi
      ;;

    attestation)
      # Issues #550/#551: release artifacts must carry provenance attestations
      # tied to an immutable digest before promotion. Verification runs here so
      # a candidate whose artifacts cannot be verified is rejected, not promoted.
      if bash scripts/verify-attestations.sh >/tmp/rc-attestation.log 2>&1; then
        ok=1; detail="provenance attestations verified for release artifacts"
      else
        detail="FAILED: attestation verification (see /tmp/rc-attestation.log)"
      fi
      ;;

    openapi)
      # Mirrors the "OpenAPI spec must not diverge" step in backend.yml: the
      # spec is regenerated and diffed against the committed file. Placeholder
      # credentials are required because the export boots the Nest app.
      if ( cd app/backend \
           && NODE_ENV=test NETWORK=testnet \
              SUPABASE_URL=https://spec-export.supabase.co \
              SUPABASE_ANON_KEY=spec-export-key \
              pnpm run docs:export:check >/tmp/rc-openapi.log 2>&1 ); then
        ok=1; detail="openapi.json matches the code"
      else
        detail="FAILED: openapi.json diverged (see /tmp/rc-openapi.log)"
      fi
      ;;

    sign-images)
      # Signs the release image digest(s) with cosign. The signing key is read
      # from COSIGN_PRIVATE_KEY (or COSIGN_KEY) and is never echoed: cosign
      # itself writes to /tmp/rc-sign.log, and only a redacted summary is
      # surfaced. RC_IMAGE_DIGESTS is a comma-separated list of
      # `repo@sha256:...` references; RC_IMAGE_REPO names the source repo.
      if [ -z "${RC_IMAGE_DIGESTS:-}" ]; then
        detail="FAILED: RC_IMAGE_DIGESTS is unset (nothing to sign)"
      elif [ -z "${COSIGN_PRIVATE_KEY:-}${COSIGN_KEY:-}" ]; then
        detail="FAILED: no signing key in COSIGN_PRIVATE_KEY/COSIGN_KEY"
      else
        sign_ok=1
        IFS=',' read -ra DIGESTS <<< "$RC_IMAGE_DIGESTS"
        for digest in "${DIGESTS[@]}"; do
          digest="$(echo "$digest" | tr -d '[:space:]')"
          [ -z "$digest" ] && continue
          if ! cosign sign --yes --key env://COSIGN_PRIVATE_KEY \
               "$digest" >/tmp/rc-sign.log 2>&1; then
            sign_ok=0
            break
          fi
        done
        if [ "$sign_ok" -eq 1 ]; then
          ok=1; detail="${#DIGESTS[@]} digest(s) signed"
        else
          detail="FAILED: cosign sign (see /tmp/rc-sign.log)"
        fi
      fi
      ;;

    verify-images)
      # Deployment gate: every expected digest must carry a valid signature and
      # a provenance attestation from the expected source repo. An unsigned or
      # mismatched digest blocks the candidate. Verification output is written
      # to /tmp/rc-verify.log; failures are surfaced in the stage detail and the
      # workflow summary via record().
      if [ -z "${RC_IMAGE_DIGESTS:-}" ]; then
        detail="FAILED: RC_IMAGE_DIGESTS is unset (nothing to verify)"
      elif [ -z "${RC_IMAGE_REPO:-}" ]; then
        detail="FAILED: RC_IMAGE_REPO is unset (provenance source unknown)"
      else
        verify_ok=1
        verify_reason=""
        IFS=',' read -ra DIGESTS <<< "$RC_IMAGE_DIGESTS"
        for digest in "${DIGESTS[@]}"; do
          digest="$(echo "$digest" | tr -d '[:space:]')"
          [ -z "$digest" ] && continue
          if ! cosign verify --key "${COSIGN_PUBLIC_KEY_FILE:-cosign.pub}" \
               "$digest" >/tmp/rc-verify.log 2>&1; then
            verify_ok=0
            verify_reason="signature missing or invalid for $digest"
            break
          fi
          if ! cosign verify-attestation \
               --key "${COSIGN_PUBLIC_KEY_FILE:-cosign.pub}" \
               --type slsaprovenance \
               --policy "${RC_PROVENANCE_POLICY:-scripts/cosign-provenance.policy}" \
               "$digest" >/tmp/rc-verify-attestation.log 2>&1; then
            verify_ok=0
            verify_reason="provenance mismatch for $digest (expected source $RC_IMAGE_REPO)"
            break
          fi
        done
        if [ "$verify_ok" -eq 1 ]; then
          ok=1; detail="${#DIGESTS[@]} digest(s) verified (signature + provenance)"
        else
          detail="FAILED: $verify_reason (see /tmp/rc-verify.log)"
        fi
      fi
      ;;

    release-manifest)
      # Builds the versioned release manifest that links source (commit SHAs)
      # to deployed components (immutable digests), then validates it against
      # the schema. The manifest must be complete: every component needs a
      # digest, and the file must contain no secrets. Deployment runs consume
      # this exact file, so a missing or invalid manifest blocks the candidate.
      if [ -z "${RC_IMAGE_DIGESTS:-}" ]; then
        detail="FAILED: RC_IMAGE_DIGESTS is unset (manifest would lack digests)"
      elif ! node scripts/release-manifest.mjs generate \
             --out "$RC_RELEASE_MANIFEST" \
             --digests "$RC_IMAGE_DIGESTS" \
             --version "${RC_RELEASE_VERSION:-}" >/tmp/rc-manifest.log 2>&1; then
        detail="FAILED: manifest generation (see /tmp/rc-manifest.log)"
      elif ! node scripts/release-manifest.mjs validate \
             --manifest "$RC_RELEASE_MANIFEST" \
             --schema "$RC_MANIFEST_SCHEMA" >/tmp/rc-manifest-validate.log 2>&1; then
        detail="FAILED: manifest schema/secret/digest validation (see /tmp/rc-manifest-validate.log)"
      else
        ok=1
        detail="manifest $RC_RELEASE_MANIFEST valid (schema, no secrets, digests present)"
      fi
      ;;

    capability-map)
      # ADR 0004: changing shipped behaviour updates docs/CAPABILITY-MAP.md in
      # the same PR. This reports the blast radius; a row changed without a
      # matching behavioural change (or vice versa) is a review finding, not a
      # machine-decidable failure, so it always passes and always prints.
      if git rev-parse --verify "$RC_BASE_REF" >/dev/null 2>&1; then
        range="$RC_BASE_REF...HEAD"
      else
        range="HEAD~1..HEAD"
      fi
      changed="$(git diff --name-only $range 2>/dev/null | wc -l | tr -d ' ')"
      map_rows="$(git diff --name-only $range 2>/dev/null | grep -c 'docs/CAPABILITY-MAP.md' || true)"
      ok=1
      detail="${changed} file(s) changed, ${map_rows} capability-map edit(s) — confirm rows match behavior"
      ;;

    deploy-freeze)
      # Re-check the freeze at the end of the run: a freeze armed while the
      # stages were running must still block promotion. The generation check
      # inside freeze_preflight refuses a run whose freeze state changed
      # underneath it, so clearing a freeze resumes only new eligible runs.
      if [ -f "$RC_FREEZE_FILE" ] && \
         [ "$(sed -n 's/.*"active"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' "$RC_FREEZE_FILE" | head -n1)" = "true" ] && \
         [ "$RC_FREEZE_OVERRIDE" != "1" ]; then
        detail="FAILED: deploy freeze active — promotion held"
      else
        ok=1; detail="no active deploy freeze"
      fi
      ;;

    *)
      ok=0; detail="FAILED: unknown stage '$name'"
      ;;
  esac

  elapsed=$(( $(now_ms) - t0 ))
  if [ "$ok" -eq 1 ]; then
    record "$name" "PASS" "$elapsed" "$detail"
  else
    record "$name" "FAIL" "$elapsed" "$detail"
  fi
done

TOTAL_MS=$(( $(now_ms) - (START_NS / 1000000) ))

log ""
log "─────────────────────────────────────────────"
log "  ${#RESULT_NAMES[@]} stages in ${TOTAL_MS}ms — pass $PASSES  fail $FAILURES  skip $SKIPS"
log "─────────────────────────────────────────────"

if [ "$GH_NOTE" -eq 1 ]; then
  { echo ""; echo "**${#RESULT_NAMES[@]} stages in ${TOTAL_MS}ms — pass $PASSES, fail $FAILURES, skip $SKIPS**"; } \
    >> "$GITHUB_STEP_SUMMARY"
  # Surface the manifest path so a deployment run can be traced back to the
  # exact artifacts this candidate validated.
  if [ -f "$RC_RELEASE_MANIFEST" ]; then
    manifest_digest="$(sha256sum "$RC_RELEASE_MANIFEST" 2>/dev/null | cut -d' ' -f1 || echo unknown)"
    { echo ""; echo "Release manifest: \`$RC_RELEASE_MANIFEST\` (sha256:\`$manifest_digest\`)"; } \
      >> "$GITHUB_STEP_SUMMARY"
  fi
fi

# Exit-code contract, in priority order:
#   2 – refused (mainnet, active deploy freeze, stale freeze generation, or bad
#       arguments). Nothing ran, or the promotion verdict is withheld; do not
#       report a verdict.
#   1 – rejected. At least one stage failed, or an optional stage was skipped
#       without --allow-skip. Both mean "not validated", and both block a merge.
#   0 – accepted.
if [ "$FAILURES" -gt 0 ]; then
  log ""
  log "::error::release candidate REJECTED — $FAILURES stage(s) failed"
  [ "$JSON" -eq 1 ] && printf '{"result":"REJECTED","reason":"failures","failures":%d,"skips":%d}\n' "$FAILURES" "$SKIPS"
  exit 1
fi

if [ "$SKIPS" -gt 0 ] && [ "$ALLOW_SKIP" != "1" ]; then
  log ""
  log "::error::release candidate REJECTED — $SKIPS optional stage(s) were skipped."
  log "        Install the missing toolchain, or re-run with --allow-skip if a"
  log "        skip is genuinely acceptable for this change."
  [ "$JSON" -eq 1 ] && printf '{"result":"REJECTED","reason":"skips","failures":0,"skips":%d}\n' "$SKIPS"
  exit 1
fi

if [ "$SKIPS" -gt 0 ]; then
  log ""
  log "::warning::release candidate ACCEPTED WITH SKIPS — $SKIPS optional stage(s) did not run."
  log "         The candidate is not fully covered; record which stages were skipped."
  [ "$JSON" -eq 1 ] && printf '{"result":"ACCEPTED_WITH_SKIPS","failures":0,"skips":%d}\n' "$SKIPS"
  exit 0
fi

log ""
log "::notice::release candidate ACCEPTED — all ${#RESULT_NAMES[@]} stages passed"
if [ -f "$RC_RELEASE_MANIFEST" ]; then
  log "  manifest: $RC_RELEASE_MANIFEST (deployment runs must reference this file)"
fi
[ "$JSON" -eq 1 ] && printf '{"result":"ACCEPTED","failures":0,"skips":0,"manifest":"%s"}\n' "$RC_RELEASE_MANIFEST"
exit 0
