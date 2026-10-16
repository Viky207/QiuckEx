export default {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": "ts-jest",
  },
  collectCoverageFrom: ["src/**/*.(t|j)s", "!src/**/*spec.ts"],
  coverageDirectory: "./coverage",
  testEnvironment: "node",
  setupFiles: ["<rootDir>/jest.setup.ts"],
  testTimeout: 10000,
  maxWorkers: "50%",
  // Issue #204: server-side authorization tests for every admin controller.
  // Admin controllers live under src/admin; keep their specs discoverable and
  // enforce a coverage floor on the admin authorization surface so regressions
  // in 401/403 handling fail CI.
  testPathIgnorePatterns: ["/node_modules/"],
  coverageThreshold: {
    // Issue #385: enforce a global coverage floor across all backend modules so
    // CI fails when statement/branch/function/line coverage regresses.
    global: {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
    "./src/admin/**/*.ts": {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
