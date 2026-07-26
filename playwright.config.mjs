import { defineConfig } from "@playwright/test";

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: 0,
  workers: 1,
  reporter: isCI ? "line" : "list",
  timeout: 20_000,
  expect: { timeout: 6_000 },
  outputDir: "test-results/playwright",
  use: {
    viewport: { width: 1280, height: 900 },
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-US",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "workspace",
      testMatch: "workspace.spec.mjs",
      use: { browserName: "chromium", baseURL: "http://127.0.0.1:4173" },
    },
    {
      name: "presentation",
      testMatch: "presentation.spec.mjs",
      use: { browserName: "chromium", baseURL: "http://127.0.0.1:4174/vector-placement-operations/" },
    },
  ],
  webServer: [
    {
      command: "node scripts/serve-e2e.mjs",
      url: "http://127.0.0.1:4173/api/health/ready",
      timeout: 15_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "node scripts/serve-site.mjs",
      url: "http://127.0.0.1:4174/vector-placement-operations/",
      timeout: 10_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
