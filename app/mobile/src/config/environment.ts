export type EnvironmentId = 'production' | 'staging' | 'testnet' | 'branch-preview' | 'dev';

export interface EnvironmentConfig {
  id: EnvironmentId;
  label: string;
  apiUrl: string;
  stellarNetwork: 'mainnet' | 'testnet';
  buildTag?: string;
}

export const ENVIRONMENTS: Record<EnvironmentId, EnvironmentConfig> = {
  production: {
    id: 'production',
    label: 'Production',
    apiUrl: 'https://api.quickex.to',
    stellarNetwork: 'mainnet',
  },
  staging: {
    id: 'staging',
    label: 'Staging',
    apiUrl: 'https://staging-api.quickex.to',
    stellarNetwork: 'testnet',
    buildTag: 'staging',
  },
  testnet: {
    id: 'testnet',
    label: 'Shared Testnet',
    apiUrl: 'https://testnet-api.quickex.to',
    stellarNetwork: 'testnet',
    buildTag: 'testnet',
  },
  'branch-preview': {
    id: 'branch-preview',
    label: 'Branch Preview',
    apiUrl: 'https://preview-api.quickex.to',
    stellarNetwork: 'testnet',
    buildTag: 'preview',
  },
  dev: {
    id: 'dev',
    label: 'Development',
    apiUrl: 'http://localhost:4000',
    stellarNetwork: 'testnet',
    buildTag: 'dev',
  },
};

export const DEFAULT_ENVIRONMENT: EnvironmentId = 'production';

export interface BackendMetadata {
  appVersion: string;
  minAppVersion: string;
  environment: string;
  stellarNetwork: string;
}

export interface CompatibilityResult {
  compatible: boolean;
  reason?: string;
}

/**
 * Type guard that reports whether an arbitrary value is a known EnvironmentId.
 */
export function isEnvironmentId(value: unknown): value is EnvironmentId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ENVIRONMENTS, value);
}

/**
 * Resolves the effective environment from a stored value.
 *
 * Precedence:
 *   1. A valid stored environment id overrides the default.
 *   2. Missing, empty, or invalid stored values fall back to DEFAULT_ENVIRONMENT.
 *
 * The default is production/mainnet, so an unset or corrupt stored value can
 * never silently point the client at a non-production API.
 */
export function resolveEnvironment(stored?: string | null): EnvironmentConfig {
  if (isEnvironmentId(stored)) {
    return ENVIRONMENTS[stored];
  }
  return ENVIRONMENTS[DEFAULT_ENVIRONMENT];
}
```

File: app/mobile/src/config/environment.unit.spec.ts

```typescript
import {
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  isEnvironmentId,
  resolveEnvironment,
} from './environment';

describe('mobile environment precedence', () => {
  it('defaults to production on mainnet', () => {
    expect(DEFAULT_ENVIRONMENT).toBe('production');
    const config = ENVIRONMENTS[DEFAULT_ENVIRONMENT];
    expect(config.id).toBe('production');
    expect(config.stellarNetwork).toBe('mainnet');
    expect(config.apiUrl).toBe('https://api.quickex.to');
  });

  it('resolves the default when no stored environment is present', () => {
    expect(resolveEnvironment(undefined)).toBe(ENVIRONMENTS.production);
    expect(resolveEnvironment(null)).toBe(ENVIRONMENTS.production);
    expect(resolveEnvironment('')).toBe(ENVIRONMENTS.production);
  });

  it('lets a valid stored environment override the default', () => {
    expect(resolveEnvironment('staging')).toBe(ENVIRONMENTS.staging);
    expect(resolveEnvironment('testnet')).toBe(ENVIRONMENTS.testnet);
    expect(resolveEnvironment('branch-preview')).toBe(ENVIRONMENTS['branch-preview']);
    expect(resolveEnvironment('dev')).toBe(ENVIRONMENTS.dev);
  });

  it('falls back to the default for invalid stored values', () => {
    expect(resolveEnvironment('nonsense')).toBe(ENVIRONMENTS.production);
    expect(resolveEnvironment('PRODUCTION')).toBe(ENVIRONMENTS.production);
    expect(resolveEnvironment('__proto__')).toBe(ENVIRONMENTS.production);
    expect(resolveEnvironment('toString')).toBe(ENVIRONMENTS.production);
  });

  it('recognises only known environment ids', () => {
    expect(isEnvironmentId('production')).toBe(true);
    expect(isEnvironmentId('dev')).toBe(true);
    expect(isEnvironmentId('unknown')).toBe(false);
    expect(isEnvironmentId('')).toBe(false);
    expect(isEnvironmentId(null)).toBe(false);
    expect(isEnvironmentId(undefined)).toBe(false);
    expect(isEnvironmentId(42)).toBe(false);
    expect(isEnvironmentId({})).toBe(false);
  });

  it('keeps every non-production environment on testnet', () => {
    for (const id of Object.keys(ENVIRONMENTS) as Array<keyof typeof ENVIRONMENTS>) {
      if (id === 'production') continue;
      expect(ENVIRONMENTS[id].stellarNetwork).toBe('testnet');
    }
  });
});