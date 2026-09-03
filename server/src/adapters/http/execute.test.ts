import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { execute } from "./execute.js";
import { HTTP_ADAPTER_ALLOWED_HOSTS_ENV } from "./url-guard.js";

const originalAllowedHosts = process.env[HTTP_ADAPTER_ALLOWED_HOSTS_ENV];

afterEach(() => {
  if (originalAllowedHosts == null) {
    delete process.env[HTTP_ADAPTER_ALLOWED_HOSTS_ENV];
  } else {
    process.env[HTTP_ADAPTER_ALLOWED_HOSTS_ENV] = originalAllowedHosts;
  }
});

describe("http adapter execute", () => {
  it("reports configured request timeout as timed_out", async () => {
    const server = http.createServer(() => {
      // Hold the socket open until the adapter timeout aborts.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    process.env[HTTP_ADAPTER_ALLOWED_HOSTS_ENV] = "127.0.0.1";

    try {
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Agent",
          adapterType: "http",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          url: `http://127.0.0.1:${port}/webhook`,
          timeoutMs: 50,
        },
        context: {},
        onLog: async () => {},
      });

      expect(result.timedOut).toBe(true);
      expect(result.errorCode).toBe("timeout");
      expect(result.errorMessage).toContain("timed out after 50ms");
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
