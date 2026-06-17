import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3105);
const BASE_URL = process.env.PAPERCLIP_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
// When BASE_URL is provided externally we assume the server is already running
// (legacy behaviour); otherwise we boot a dedicated throwaway authenticated
// instance just like the default e2e config.
const BOOT_OWN_SERVER = !process.env.PAPERCLIP_E2E_BASE_URL;
const PAPERCLIP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-e2e-auth-home-"));

export default defineConfig({
  testDir: ".",
  testMatch: "multi-user-authenticated.spec.ts",
  timeout: 180_000,
  expect: {
    timeout: 20_000,
  },
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  // Boot a throwaway instance in *authenticated* mode (the suite asserts
  // health.deploymentMode === "authenticated" and exercises signup/invite/join).
  ...(BOOT_OWN_SERVER
    ? {
        webServer: {
          command: `pnpm paperclipai onboard --yes --run`,
          url: `${BASE_URL}/api/health`,
          reuseExistingServer: false,
          timeout: 120_000,
          stdout: "pipe" as const,
          stderr: "pipe" as const,
          env: {
            ...process.env,
            PORT: String(PORT),
            PAPERCLIP_HOME,
            PAPERCLIP_INSTANCE_ID: "playwright-e2e-auth",
            PAPERCLIP_BIND: "loopback",
            PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
            PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
          },
        },
      }
    : {}),
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
