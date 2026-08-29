import { defineConfig } from "@playwright/test";

const runningInCi = process.env.CI === "1" || process.env.CI === "true";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  forbidOnly: runningInCi,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000, toHaveScreenshot: { maxDiffPixelRatio: 0.005 } },
  reporter: runningInCi
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4175",
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 4175",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
