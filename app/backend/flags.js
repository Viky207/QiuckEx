/**
 * Safe Rollback & Feature Flag Strategy Guard
 * Fulfills Task 3 & AC 3 for Issue #416
 *
 * Administrative surface (Issue #202): feature-flag reads/writes and audit
 * reads are gated behind scoped administrative auth. Unauthorized, malformed,
 * and dependency-failure cases return stable error codes.
 */

// Stable, documented error codes for the administrative surface.
const ADMIN_ERRORS = {
  UNAUTHORIZED: 'ADMIN_UNAUTHORIZED',
  FORBIDDEN_SCOPE: 'ADMIN_FORBIDDEN_SCOPE',
  MALFORMED_REQUEST: 'ADMIN_MALFORMED_REQUEST',
  DEPENDENCY_FAILURE: 'ADMIN_DEPENDENCY_FAILURE'
};

// Administrative scopes required by each protected capability.
const ADMIN_SCOPES = {
  'flags:read': 'flags:read',
  'flags:write': 'flags:write',
  'audit:read': 'audit:read'
};

function adminError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  err.status = code === ADMIN_ERRORS.UNAUTHORIZED ? 401
    : code === ADMIN_ERRORS.FORBIDDEN_SCOPE ? 403
    : code === ADMIN_ERRORS.MALFORMED_REQUEST ? 400
    : 503;
  return err;
}

/**
 * Resolve the caller's administrative scopes from the request context.
 * Self-custody is preserved: no key material is read or logged here.
 */
function resolveAdminScopes(context) {
  if (!context || typeof context !== 'object') {
    throw adminError(ADMIN_ERRORS.UNAUTHORIZED, 'Missing administrative context');
  }
  const scopes = context.adminScopes;
  if (!Array.isArray(scopes)) {
    throw adminError(ADMIN_ERRORS.UNAUTHORIZED, 'Missing administrative scopes');
  }
  return scopes;
}

/**
 * Enforce a required administrative scope. Throws stable errors for
 * unauthorized and insufficient-scope callers.
 */
function requireAdminScope(context, requiredScope) {
  const scopes = resolveAdminScopes(context);
  if (!scopes.includes(requiredScope)) {
    throw adminError(ADMIN_ERRORS.FORBIDDEN_SCOPE, `Missing required scope: ${requiredScope}`);
  }
  return true;
}

const RollbackGuard = {
  ADMIN_ERRORS,
  ADMIN_SCOPES,
  requireAdminScope,

  // Checks if a newly deployed feature is active via environment configuration
  isFeatureActive(flagName) {
    const envKey = `FEATURE_${flagName.toUpperCase()}`;
    return process.env[envKey] === 'true';
  },

  // Safely wraps new code. If it crashes, it instantly falls back to the previous logic.
  async executeSafely(flagName, newFeaturePath, previousStablePath) {
    if (this.isFeatureActive(flagName)) {
      try {
        return await newFeaturePath();
      } catch (error) {
        console.error(`[ROLLBACK GUARD] Feature '${flagName}' failed! Falling back to safe state.`, error);
        return await previousStablePath();
      }
    }
    return await previousStablePath();
  },

  // Issue #216: Horizon circuit-breaker recovery and bounded stale-cache behavior.
  // Feature-gated so it is not enabled on mainnet until explicitly opted in.
  isHorizonCircuitBreakerEnabled() {
    return this.isFeatureActive('HORIZON_CIRCUIT_BREAKER');
  },

  // Bounded staleness window (ms) for serving cached Horizon data during outages.
  // Defaults to 30s; clamped to a safe upper bound so stale data can never be
  // served indefinitely. Returns 0 when the capability is disabled.
  getHorizonStaleCacheTtlMs() {
    if (!this.isHorizonCircuitBreakerEnabled()) {
      return 0;
    }
    const DEFAULT_TTL_MS = 30000;
    const MAX_TTL_MS = 300000;
    const raw = Number(process.env.HORIZON_STALE_CACHE_TTL_MS);
    if (!Number.isFinite(raw) || raw <= 0) {
      return DEFAULT_TTL_MS;
    }
    return Math.min(raw, MAX_TTL_MS);
  },

  // Issue #372: X-Ray privacy mode (shielded transactions) is gated behind the
  // `mainnet.xray_privacy_enabled` flag. The on-chain Groth16 verifier stub in
  // the privacy contract is only exercised when this flag is explicitly opted
  // in, so mainnet stays on the UI-only path until the verifier is deployed and
  // cryptographer-reviewed.
  isXrayPrivacyEnabled() {
    return process.env.MAINNET_XRAY_PRIVACY_ENABLED === 'true';
  }
};

module.exports = RollbackGuard;
