import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./visual",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.002,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  use: {
    baseURL: "http://127.0.0.1:3173",
    browserName: "chromium",
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  outputDir: "test-results",
  snapshotDir: "./visual/snapshots",
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3173",
    url: "http://127.0.0.1:3173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_QUICKEX_API_URL: "http://127.0.0.1:4001",
      NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
      NEXT_PUBLIC_ERROR_REPORTING_ENABLED: "false",
    },
  },
});