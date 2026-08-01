import { defineConfig } from "@playwright/test";
import { resolveE2ePorts } from "./scripts/e2e-ports.mjs";

const isCI = Boolean(process.env.CI);
const { presentation: presentationPort, workspace: workspacePort } = resolveE2ePorts();
const presentationBaseUrl = `http://127.0.0.1:${presentationPort}/vector-placement-operations/`;
const workspaceBaseUrl = `http://127.0.0.1:${workspacePort}`;

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
      name: "presentation",
      testMatch: "presentation.spec.mjs",
      use: { browserName: "chromium", baseURL: presentationBaseUrl },
    },
    {
      name: "workspace",
      testMatch: "workspace.spec.mjs",
      use: { browserName: "chromium", baseURL: workspaceBaseUrl },
    },
    {
      name: "presentation-webkit-smoke",
      testMatch: "presentation.spec.mjs",
      grep: /loads as an honest public presentation|remains inside the viewport without an API-backed workspace/,
      use: { browserName: "webkit", baseURL: presentationBaseUrl },
    },
    {
      name: "workspace-webkit-smoke",
      testMatch: "workspace.spec.mjs",
      grep: /shows structured CSV validation errors|paginates, filters and exports a bounded audit trail|keeps every authenticated role accessible/,
      use: { browserName: "webkit", baseURL: workspaceBaseUrl },
    },
  ],
  webServer: [
    {
      command: "node scripts/serve-e2e.mjs",
      url: `${workspaceBaseUrl}/api/health/ready`,
      timeout: 15_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "node scripts/serve-site.mjs",
      url: presentationBaseUrl,
      timeout: 10_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
