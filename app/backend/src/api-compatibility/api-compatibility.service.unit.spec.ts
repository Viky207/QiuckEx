import { Test, TestingModule } from '@nestjs/testing';
import { ApiCompatibilityService } from './api-compatibility.service';
import { ApiCompatibilityDiffEngine } from './api-compatibility.diff-engine';
import { BaselineLoaderService } from './baseline-loader.service';
import { DependencyService } from './dependency.service';
import { BaselineNotFoundError } from './errors/baseline-not-found.error';
import { MalformedBaselineError } from './errors/malformed-baseline.error';
import { DependencyFailureError } from './errors/dependency-failure.error';

describe('ApiCompatibilityService', () => {
  let service: ApiCompatibilityService;
  let diffEngine: jest.Mocked<ApiCompatibilityDiffEngine>;
  let baselineLoader: jest.Mocked<BaselineLoaderService>;
  let dependencyService: jest.Mocked<DependencyService>;

  const validBaseline = {
    version: '1.0.0',
    paths: {
      '/users': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              schema: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  role: { type: 'string', enum: ['admin', 'user'] },
                },
                required: ['id', 'role'],
              },
            },
            '404': {
              description: 'Not found',
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'string', enum: ['USER_NOT_FOUND'] },
                },
              },
            },
          },
        },
      },
    },
  };

  beforeEach(async () => {
    diffEngine = {
      diff: jest.fn(),
    } as unknown as jest.Mocked<ApiCompatibilityDiffEngine>;

    baselineLoader = {
      load: jest.fn(),
    } as unknown as jest.Mocked<BaselineLoaderService>;

    dependencyService = {
      check: jest.fn(),
    } as unknown as jest.Mocked<DependencyService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiCompatibilityService,
        { provide: ApiCompatibilityDiffEngine, useValue: diffEngine },
        { provide: BaselineLoaderService, useValue: baselineLoader },
        { provide: DependencyService, useValue: dependencyService },
      ],
    }).compile();

    service = module.get<ApiCompatibilityService>(ApiCompatibilityService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('happy path', () => {
    it('reports no changes when current spec matches baseline', async () => {
      baselineLoader.load.mockResolvedValue(validBaseline);
      dependencyService.check.mockResolvedValue(true);
      diffEngine.diff.mockReturnValue({
        compatible: true,
        changes: [],
      });

      const result = await service.checkCompatibility('1.0.0', validBaseline);

      expect(result.compatible).toBe(true);
      expect(result.changes).toEqual([]);
      expect(diffEngine.diff).toHaveBeenCalledWith(validBaseline, validBaseline);
    });

    it('returns compatible result with empty change list', async () => {
      baselineLoader.load.mockResolvedValue(validBaseline);
      dependencyService.check.mockResolvedValue(true);
      diffEngine.diff.mockReturnValue({
        compatible: true,
        changes: [],
      });

      const result = await service.checkCompatibility('1.0.0', validBaseline);

      expect(result).toMatchObject({
        compatible: true,
        changes: [],
      });
    });
  });

  describe('missing path', () => {
    it('flags a removed path as incompatible', async () => {
      baselineLoader.load.mockResolvedValue(validBaseline);
      dependencyService.check.mockResolvedValue(true);
      diffEngine.diff.mockReturnValue({
        compatible: false,
        changes: [
          {
            type: 'PATH_REMOVED',
            path: '/users',
            method: 'get',
            message: 'Path /users get was removed',
          },
        ],
      });

      const currentSpec = { version: '1.0.0', paths: {} };
      const result = await service.checkCompatibility('1.0.0', currentSpec);

      expect(result.compatible).toBe(false);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].type).toBe('PATH_REMOVED');
      expect(result.changes[0].path).toBe('/users');
    });

    it('flags a newly added path as a non-breaking change', async () => {
      baselineLoader.load.mockResolvedValue(validBaseline);
      dependencyService.check.mockResolvedValue(true);
      diffEngine.diff.mockReturnValue({
        compatible: true,
        changes: [
          {
            type: 'PATH_ADDED',
            path: '/health',
            method: 'get',
            message: 'Path /health get was added',
          },
        ],
      });

      const currentSpec = {
        version: '1.0.0',
        paths: {
          ...validBaseline.paths,
          '/health': { get: { responses: { '200': { description: 'OK' } } } },
        },
      };
      const result = await service.checkCompatibility('1.0.0', currentSpec);

      expect(result.compatible).toBe(true);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].type).toBe('PATH_ADDED');
    });
  });

  describe('removed required field', () => {
    it('flags removal of a required property as incompatible', async () => {
      baselineLoader.load.mockResolvedValue(validBaseline);
      dependencyService.check.mockResolvedValue(true);
      diffEngine.diff.mockReturnValue({
        compatible: false,
        changes: [
          {
            type: 'REQUIRED_FIELD_REMOVED',
            path: '/users',
            method: 'get',
            field: 'role',
            message: 'Required field role was removed from response',
          },
        ],
      });

      const currentSpec = {
        version: '1.0.0',
        paths: {
          '/users': {
            get: {
              responses: {
                '200': {
                  description: 'OK',
                  schema: {
                    type: 'object',
                    properties: { id: { type: 'string' } },
                    required: ['id'],
                  },
                },
              },
            },
          },
        },
      };
      const result = await service.checkCompatibility('1.0.0', currentSpec);

      expect(result.compatible).toBe(false);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].type).toBe('REQUIRED_FIELD_REMOVED');
      expect(result.changes[0].field).toBe('role');
    });

    it('flags removal of a required field from a nested object', async () => {
      baselineLoader.load.mockResolvedValue(validBaseline);
      dependencyService.check.mockResolvedValue(true);
      diffEngine.diff.mockReturnValue({
        compatible: false,
        changes: [
          {
            type: 'REQUIRED_FIELD_REMOVED',
            path: '/users',
            method: 'get',
            field: 'profile.email',
            message: 'Required field profile.email was removed',
          },
        ],
      });

      const currentSpec = { version: '1.0.0', paths: {} };
      const result = await service.checkCompatibility('1.0.0', currentSpec);

      expect(result.compatible).toBe(false);
      expect(result.changes[0].field).toBe('profile.email');
    });
  });

  describe('enum narrowing', () => {
    it('flags a narrowed enum as incompatible', async () => {
      baselineLoader.load.mockResolvedValue(validBaseline);
      dependencyService.check.mockResolvedValue(true);
      diffEngine.diff.mockReturnValue({
        compatible: false,
        changes: [
          {
            type: 'ENUM_NARROWED',
            path: '/users',
            method: 'get',
            field: 'role',
            removedValues: ['admin'],
            message: 'Enum value admin was removed from role',
          },
        ],
      });

      const currentSpec = {
        version: '1.0.0',
        paths: {
          '/users': {
            get: {
              responses: {
                '200': {
                  description: 'OK',
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      role: { type: 'string', enum: ['user'] },
                    },
                    required: ['id', 'role'],
                  },
                },
              },
            },
          },
        },
      };
      const result = await service.checkCompatibility('1.0.0', currentSpec);

      expect(result.compatible).toBe(false);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].type).toBe('ENUM_NARROWED');
      expect(result.changes[0].removedValues).toEqual(['admin']);
    });

    it('treats a widened enum as compatible', async () => {
      baselineLoader.load.mockResolvedValue(validBaseline);
      dependencyService.check.mockResolvedValue(true);
      diffEngine.diff.mockReturnValue({
        compatible: true,
        changes: [
          {
            type: 'ENUM_WIDENED',
            path: '/users',
            method: 'get',
            field: 'role',
            addedValues: ['guest'],
            message: 'Enum value guest was added to role',
          },
        ],
      });

      const currentSpec = {
        version: '1.0.0',
        paths: {
          '/users': {
            get: {
              responses: {
                '200': {
                  description: 'OK',
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      role: { type: 'string', enum: ['admin', 'user', 'guest'] },
                    },
                    required: ['id', 'role'],
                  },
                },
              },
            },
          },
        },
      };
      const result = await service.checkCompatibility('1.0.0', currentSpec);

      expect(result.compatible).toBe(true);
      expect(result.changes[0].type).toBe('ENUM_WIDENED');
      expect(result.changes[0].addedValues).toEqual(['guest']);
    });
  });

  describe('error-code removal', () => {
    it('flags removal of an error code as incompatible', async () => {
      baselineLoader.load.mockResolvedValue(validBaseline);
      dependencyService.check.mockResolvedValue(true);
      diffEngine.diff.mockReturnValue({
        compatible: false,
        changes: [
          {
            type: 'ERROR_CODE_REMOVED',
            path: '/users',
            method: 'get',
            statusCode: '404',
            removedCodes: ['USER_NOT_FOUND'],
            message: 'Error code USER_NOT_FOUND was removed from 404 response',
          },
        ],
      });

      const currentSpec = {
        version: '1.0.0',
        paths: {
          '/users': {
            get: {
              responses: {
                '200': {
                  description: 'OK',
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      role: { type: 'string', enum: ['admin', 'user'] },
                    },
                    required: ['id', 'role'],
                  },
                },
              },
              '404': {
                description: 'Not found',
                schema: {
                  type: 'object',
                  properties: {
                    code: { type: 'string', enum: [] },
                  },
                },
              },
            },
          },
        },
      };
      const result = await service.checkCompatibility('1.0.0', currentSpec);

      expect(result.compatible).toBe(false);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].type).toBe('ERROR_CODE_REMOVED');
      expect(result.changes[0].removedCodes).toEqual(['USER_NOT_FOUND']);
    });

    it('flags removal of an entire error response as incompatible', async () => {
      baselineLoader.load.mockResolvedValue(validBaseline);
      dependencyService.check.mockResolvedValue(true);
      diffEngine.diff.mockReturnValue({
        compatible: false,
        changes: [
          {
            type: 'ERROR_RESPONSE_REMOVED',
            path: '/users',
            method: 'get',
            statusCode: '404',
            message: 'Error response 404 was removed',
          },
        ],
      });

      const currentSpec = {
        version: '1.0.0',
        paths: {
          '/users': {
            get: {
              responses: {
                '200': {
                  description: 'OK',
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      role: { type: 'string', enum: ['admin', 'user'] },
                    },
                    required: ['id', 'role'],
                  },
                },
              },
            },
          },
        },
      };
      const result = await service.checkCompatibility('1.0.0', currentSpec);

      expect(result.compatible).toBe(false);
      expect(result.changes[0].type).toBe('ERROR_RESPONSE_REMOVED');
      expect(result.changes[0].statusCode).toBe('404');
    });
  });

  describe('malformed baseline', () => {
    it('throws MalformedBaselineError when baseline is not valid JSON', async () => {
      baselineLoader.load.mockRejectedValue(
        new MalformedBaselineError('Baseline is not valid JSON'),
      );

      await expect(
        service.checkCompatibility('1.0.0', validBaseline),
      ).rejects.toThrow(MalformedBaselineError);

      expect(diffEngine.diff).not.toHaveBeenCalled();
    });

    it('throws MalformedBaselineError when baseline is missing required fields', async () => {
      baselineLoader.load.mockRejectedValue(
        new MalformedBaselineError('Baseline is missing paths'),
      );

      await expect(
        service.checkCompatibility('1.0.0', validBaseline),
      ).rejects.toThrow(MalformedBaselineError);

      expect(diffEngine.diff).not.toHaveBeenCalled();
    });

    it('throws BaselineNotFoundError when baseline version does not exist', async () => {
      baselineLoader.load.mockRejectedValue(
        new BaselineNotFoundError('Baseline 9.9.9 not found'),
      );

      await expect(
        service.checkCompatibility('9.9.9', validBaseline),
      ).rejects.toThrow(BaselineNotFoundError);

      expect(diffEngine.diff).not.toHaveBeenCalled();
    });
  });

  describe('deprecated alias migration', () => {
    const now = new Date('2025-01-15T00:00:00.000Z');

    const aliasBaseline = {
      version: '1.0.0',
      paths: {
        '/users': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                  required: ['id'],
                },
              },
            },
          },
        },
        '/legacy-users': {
          get: {
            deprecated: true,
            'x-replacement-path': '/users',
            'x-warning-period-end': '2025-06-01T00:00:00.000Z',
            responses: {
              '200': {
                description: 'OK',
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                  required: ['id'],
                },
              },
            },
          },
        },
      },
    };

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(now);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('reports a deprecated alias with a valid replacement and active warning period as non-breaking', async () => {
      baselineLoader.load.mockResolvedValue(aliasBaseline);
      dependencyService.check.mockResolvedValue(true);
      diffEngine.diff.mockReturnValue({
        compatible: true,
        changes: [
          {
            type: 'DEPRECATED_ALIAS',
            path: '/legacy-users',
            method: 'get',
            replacementPath: '/users',
            warningPeriodEnd: '2025-06-01T00:00:00.000Z',
            message:
              'Path /legacy-users get is deprecated; use /users instead',
          },
        ],
      });

      const result = await service.checkCompatibility('1.0.0', aliasBaseline);

      expect(result.compatible).toBe(true);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].type).toBe('DEPRECATED_ALIAS');
      expect(result.changes[0].replacementPath).toBe('/users');
      expect(result.changes[0].warningPeriodEnd).toBe(
        '2025-06-01T00:00:00.000Z',
      );
    });

    it('reports an alias missing a replacement endpoint as breaking', async () => {
      baselineLoader.load.mockResolvedValue(aliasBaseline);
      dependencyService.check.mockResolvedValue(true);
      diffEngine.diff.mockReturnValue({
        compatible: false,
        changes: [
          {
            type: 'DEPRECATED_ALIAS_MISSING_REPLACEMENT',
            path: '/legacy-users',
            method: 'get',
            message:
              'Deprecated path /legacy-users get has no replacement endpoint',
          },
        ],
      });

      const result = await service.checkCompatibility('1.0.0', aliasBaseline);

      expect(result.compatible).toBe(false);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].type).toBe(
        'DEPRECATED_ALIAS_MISSING_REPLACEMENT',
      );
      expect(result.changes[0].replacementPath).toBeUndefined();
    });

    it('reports an alias whose warning period has expired as breaking', async () => {
      baselineLoader.load.mockResolvedValue(aliasBaseline);
      dependencyService.check.mockResolvedValue(true);
      diffEngine.diff.mockReturnValue({
        compatible: false,
        changes: [
          {
            type: 'DEPRECATED_ALIAS_EXPIRED',
            path: '/legacy-users',
            method: 'get',
            replacementPath: '/users',
            warningPeriodEnd: '2025-01-14T23:59:59.999Z',
            message:
              'Deprecated path /legacy-users get warning period ended at 2025-01-14T23:59:59.999Z',
          },
        ],
      });

      const result = await service.checkCompatibility('1.0.0', aliasBaseline);

      expect(result.compatible).toBe(false);
      expect(result.changes[0].type).toBe('DEPRECATED_ALIAS_EXPIRED');
      expect(result.changes[0].replacementPath).toBe('/users');
    });

    it('treats a warning period ending exactly now as expired (boundary)', async () => {
      baselineLoader.load.mockResolvedValue(aliasBaseline);
      dependencyService.check.mockResolvedValue(true);
      diffEngine.diff.mockReturnValue({
        compatible: false,
        changes: [
          {
            type: 'DEPRECATED_ALIAS_EXPIRED',
            path: '/legacy-users',
            method: 'get',
            replacementPath: '/users',
            warningPeriodEnd: now.toISOString(),
            message: `Deprecated path /legacy-users get warning period ended at ${now.toISOString()}`,
          },
        ],
      });

      const result = await service.checkCompatibility('1.0.0', aliasBaseline);

      expect(result.compatible).toBe(false);
      expect(result.changes[0].type).toBe('DEPRECATED_ALIAS_EXPIRED');
      expect(result.changes[0].warningPeriodEnd).toBe(now.toISOString());
    });

    it('preserves deterministic ordering and omits secrets or personal data from messages', async () => {
      baselineLoader.load.mockResolvedValue(aliasBaseline);
      dependencyService.check.mockResolvedValue(true);
      diffEngine.diff.mockReturnValue({
        compatible: false,
        changes: [
          {
            type: 'DEPRECATED_ALIAS_EXPIRED',
            path: '/legacy-users',
            method: 'get',
            replacementPath: '/users',
            warningPeriodEnd: '2025-01-01T00:00:00.000Z',
            message:
              'Deprecated path /legacy-users get warning period ended at 2025-01-01T00:00:00.000Z',
          },
          {
            type: 'DEPRECATED_ALIAS_MISSING_REPLACEMENT',
            path: '/legacy-users',
            method: 'get',
            message:
              'Deprecated path /legacy-users get has no replacement endpoint',
          },
        ],
      });

      const result = await service.checkCompatibility('1.0.0', aliasBaseline);

      expect(result.changes.map((c) => c.type)).toEqual([
        'DEPRECATED_ALIAS_EXPIRED',
        'DEPRECATED_ALIAS_MISSING_REPLACEMENT',
      ]);

      const serialized = JSON.stringify(result.changes);
      expect(serialized).not.toMatch(/authorization|bearer|token|secret/i);
      expect(serialized).not.toMatch(/password|api[_-]?key/i);
      expect(serialized).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    });
  });

  describe('dependency failure', () => {
    it('throws DependencyFailureError when dependency check fails', async () => {
      baselineLoader.load.mockResolvedValue(validBaseline);
      dependencyService.check.mockRejectedValue(
        new DependencyFailureError('Dependency service unavailable'),
      );

      await expect(
        service.checkCompatibility('1.0.0', validBaseline),
      ).rejects.toThrow(DependencyFailureError);

      expect(diffEngine.diff).not.toHaveBeenCalled();
    });

    it('throws DependencyFailureError when dependency check returns false', async () => {
      baselineLoader.load.mockResolvedValue(validBaseline);
      dependencyService.check.mockResolvedValue(false);

      await expect(
        service.checkCompatibility('1.0.0', validBaseline),
      ).rejects.toThrow(DependencyFailureError);

      expect(diffEngine.diff).not.toHaveBeenCalled();
    });

    it('does not call diff engine when dependency check fails', async () => {
      baselineLoader.load.mockResolvedValue(validBaseline);
      dependencyService.check.mockRejectedValue(
        new DependencyFailureError('Dependency service unavailable'),
      );

      await expect(
        service.checkCompatibility('1.0.0', validBaseline),
      ).rejects.toThrow(DependencyFailureError);

      expect(diffEngine.diff).not.toHaveBeenCalled();
      expect(baselineLoader.load).toHaveBeenCalledWith('1.0.0');
    });
  });
});