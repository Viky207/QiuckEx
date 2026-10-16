export default {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  testRegex: ".*\\.unit\\.spec\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": "ts-jest",
  },
  collectCoverageFrom: ["src/**/*.(t|j)s", "!src/**/*spec.ts"],
  coverageDirectory: "./coverage",
  coverageReporters: ["text", "lcov", "html"],
  testEnvironment: "node",
  setupFiles: ["<rootDir>/jest.setup.ts"],
  testTimeout: 10000,
  maxWorkers: "50%",
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 70,
      functions: 80,
      lines: 80,
    },
  },
};
