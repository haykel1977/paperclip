import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Dedicated port/instance so the multi-user suite runs its own throwaway server
// (the default e2e config intentionally testIgnores multi-user.spec.ts).
const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3104);
const BASE_URL = process.env.PAPERCLIP_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const BOOT_OWN_SERVER = !process.env.PAPERCLIP_E2E_BASE_URL;
const PAPERCLIP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-e2e-mu-home-"));

export default defineConfig({
  testDir: ".",
  testMatch: "multi-user.spec.ts",
  timeout: 120_000,
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
            PAPERCLIP_INSTANCE_ID: "playwright-e2e-multiuser",
            PAPERCLIP_BIND: "loopback",
            PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
            PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
          },
        },
      }
    : {}),
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
