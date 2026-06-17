import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Playwright config for the delivery-pr E2E suite.
 *
 * Uses a dedicated port (3205) and boots its own throwaway Paperclip instance
 * in local_trusted mode. The PAPERCLIP_DELIVERY_LANE env var is set here as a
 * documentation marker — it is consumed by adapter-side delivery hooks, not by
 * the Paperclip server API itself.
 *
 * Run with:
 *   pnpm run test:e2e:delivery
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3205);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PAPERCLIP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-e2e-delivery-home-"));
const PLAYWRIGHT_CHANNEL = process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL;

export default defineConfig({
  testDir: ".",
  testMatch: "delivery-pr.spec.ts",
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
      use: {
        browserName: "chromium",
        ...(PLAYWRIGHT_CHANNEL ? { channel: PLAYWRIGHT_CHANNEL } : {}),
      },
    },
  ],
  webServer: {
    command: `pnpm paperclipai onboard --yes --run`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(PORT),
      PAPERCLIP_HOME,
      PAPERCLIP_INSTANCE_ID: "playwright-e2e-delivery",
      PAPERCLIP_BIND: "loopback",
      PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
      // Documents the intent: adapters spawned by the server in this test
      // environment should not attempt real GitHub operations. This env var
      // is read by executeConfiguredDeliveryHook inside adapter processes.
      PAPERCLIP_DELIVERY_LANE: "disabled",
    },
  },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
