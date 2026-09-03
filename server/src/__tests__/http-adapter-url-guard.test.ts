import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const dnsLookup = vi.fn();

vi.mock("node:dns", () => ({
  promises: {
    lookup: (...args: unknown[]) => dnsLookup(...args),
  },
}));

const {
  assertHttpAdapterResponseNotRedirect,
  assertSafeHttpAdapterUrl,
  assertSafeHttpAdapterUrlSync,
  HttpAdapterSsrfError,
  HTTP_ADAPTER_FETCH_REDIRECT,
  httpAdapterFetch,
  httpAdapterFetchHook,
  httpAdapterFetchInit,
  isBlockedHttpAdapterHostname,
  isBlockedHttpAdapterIp,
  parseHttpAdapterAllowedHosts,
  pinnedHttpAdapterLookup,
} = await import("../adapters/http/url-guard.js");
const { testEnvironment } = await import("../adapters/http/test.js");

describe("HTTP adapter URL guard", () => {
  afterEach(() => {
    dnsLookup.mockReset();
    httpAdapterFetchHook.current = null;
  });

  it("blocks loopback and metadata hostnames", () => {
    expect(isBlockedHttpAdapterHostname("localhost")).toBe(true);
    expect(isBlockedHttpAdapterHostname("Foo.Localhost")).toBe(true);
    expect(isBlockedHttpAdapterHostname("metadata.google.internal")).toBe(true);
    expect(isBlockedHttpAdapterHostname("example.com")).toBe(false);
  });

  it("blocks private, loopback, link-local, and CGNAT IPs", () => {
    expect(isBlockedHttpAdapterIp("127.0.0.1")).toBe(true);
    expect(isBlockedHttpAdapterIp("10.1.2.3")).toBe(true);
    expect(isBlockedHttpAdapterIp("192.168.1.9")).toBe(true);
    expect(isBlockedHttpAdapterIp("172.16.0.1")).toBe(true);
    expect(isBlockedHttpAdapterIp("169.254.169.254")).toBe(true);
    expect(isBlockedHttpAdapterIp("100.64.0.1")).toBe(true);
    expect(isBlockedHttpAdapterIp("0.0.0.0")).toBe(true);
    expect(isBlockedHttpAdapterIp("::1")).toBe(true);
    expect(isBlockedHttpAdapterIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedHttpAdapterIp("fd12:3456::1")).toBe(true);
    expect(isBlockedHttpAdapterIp("8.8.8.8")).toBe(false);
    expect(isBlockedHttpAdapterIp("1.1.1.1")).toBe(false);
  });

  it("rejects non-http(s) URLs and localhost without fetching", () => {
    expect(() => assertSafeHttpAdapterUrlSync("file:///etc/passwd")).toThrow(/protocol/i);
    expect(() => assertSafeHttpAdapterUrlSync("http://localhost/wakeup")).toThrow(/not allowed/i);
    expect(() => assertSafeHttpAdapterUrlSync("http://127.0.0.1:8080/")).toThrow(/blocked address/i);
    expect(() => assertSafeHttpAdapterUrlSync("https://169.254.169.254/latest/meta-data")).toThrow(/blocked address/i);
  });

  it("allows an explicit hostname allowlist for private endpoints", () => {
    const env = { PAPERCLIP_HTTP_ADAPTER_ALLOWED_HOSTS: "hooks.internal,127.0.0.1" };
    expect(parseHttpAdapterAllowedHosts(env.PAPERCLIP_HTTP_ADAPTER_ALLOWED_HOSTS).has("hooks.internal")).toBe(true);
    expect(assertSafeHttpAdapterUrlSync("http://127.0.0.1:8080/wakeup", env).hostname).toBe("127.0.0.1");
    expect(assertSafeHttpAdapterUrlSync("https://hooks.internal/wakeup", env).hostname).toBe("hooks.internal");
  });

  it("rejects DNS answers that resolve to a private address", async () => {
    dnsLookup.mockResolvedValueOnce([{ address: "10.0.0.8", family: 4 }]);
    await expect(assertSafeHttpAdapterUrl("https://evil.example/wakeup")).rejects.toThrow(/blocked address/i);
    expect(dnsLookup).toHaveBeenCalled();
  });

  it("accepts a public hostname whose DNS is public and pins that address", async () => {
    dnsLookup.mockResolvedValueOnce([{ address: "203.0.113.10", family: 4 }]);
    const parsed = await assertSafeHttpAdapterUrl("https://agents.example.com/wakeup");
    expect(parsed.url.hostname).toBe("agents.example.com");
    expect(parsed.pinnedAddress).toBe("203.0.113.10");
  });

  it("pins an allowlisted private hostname without blocking the resolved IP", async () => {
    dnsLookup.mockResolvedValueOnce([{ address: "10.0.0.8", family: 4 }]);
    const env = { PAPERCLIP_HTTP_ADAPTER_ALLOWED_HOSTS: "hooks.internal" };
    const parsed = await assertSafeHttpAdapterUrl("https://hooks.internal/wakeup", env);
    expect(parsed.url.hostname).toBe("hooks.internal");
    expect(parsed.pinnedAddress).toBe("10.0.0.8");
  });

  it("keeps lookup pinned to the checked address", () => {
    const lookup = pinnedHttpAdapterLookup("203.0.113.10");
    const single = vi.fn();
    lookup("evil.example", {}, single);
    expect(single).toHaveBeenCalledWith(null, "203.0.113.10", 4);
    const all = vi.fn();
    lookup("evil.example", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: "203.0.113.10", family: 4 }]);
  });

  it("connects to the pinned address while sending the original Host header", async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(String(req.headers.host));
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      const url = new URL(`http://webhook.example:${port}/wakeup`);
      const res = await httpAdapterFetch(url, { method: "GET", pinnedAddress: "127.0.0.1" });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(seen[0]).toBe(`webhook.example:${port}`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("aborts a pinned request as AbortError so execute can map timeout", async () => {
    const server = http.createServer(() => {
      // Hold the socket open until the client aborts.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const controller = new AbortController();
    const url = new URL(`http://webhook.example:${port}/wakeup`);
    const pending = httpAdapterFetch(url, {
      method: "GET",
      pinnedAddress: "127.0.0.1",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("copies URL userinfo into Basic authorization on the pinned request", async () => {
    const seen: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      const url = new URL(`http://alice:p%40ss@webhook.example:${port}/wakeup`);
      const res = await httpAdapterFetch(url, { method: "GET", pinnedAddress: "127.0.0.1" });
      expect(res.status).toBe(200);
      expect(seen[0]).toBe(`Basic ${Buffer.from("alice:p@ss").toString("base64")}`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("forces fetch redirect=manual and rejects 3xx / opaque redirects", () => {
    expect(httpAdapterFetchInit({ method: "HEAD", redirect: "follow" }).redirect).toBe(
      HTTP_ADAPTER_FETCH_REDIRECT,
    );
    expect(() =>
      assertHttpAdapterResponseNotRedirect({ type: "basic", status: 200 } as Response),
    ).not.toThrow();
    expect(() =>
      assertHttpAdapterResponseNotRedirect({ type: "basic", status: 302 } as Response),
    ).toThrow(HttpAdapterSsrfError);
    expect(() =>
      assertHttpAdapterResponseNotRedirect({ type: "opaqueredirect", status: 0 } as Response),
    ).toThrow(/refused redirect/i);
  });

  it("treats a redirect HEAD probe as an SSRF error, not a connectivity warn", async () => {
    dnsLookup.mockResolvedValueOnce([{ address: "203.0.113.10", family: 4 }]);
    const fetchMock = vi.fn().mockResolvedValue({
      type: "basic",
      status: 302,
      ok: false,
      headers: new Headers({ location: "http://127.0.0.1/" }),
    });
    httpAdapterFetchHook.current = fetchMock;
    const result = await testEnvironment({
      companyId: "00000000-0000-0000-0000-000000000001",
      adapterType: "http",
      config: { url: "https://public.example/hook" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ method: "HEAD", redirect: "manual", pinnedAddress: "203.0.113.10" }),
    );
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "http_url_ssrf_blocked" && check.level === "error")).toBe(
      true,
    );
    expect(result.checks.some((check) => check.code === "http_endpoint_probe_failed")).toBe(false);
  });
});
