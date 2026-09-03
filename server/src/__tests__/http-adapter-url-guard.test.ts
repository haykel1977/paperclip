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
  httpAdapterFetchInit,
  isBlockedHttpAdapterHostname,
  isBlockedHttpAdapterIp,
  parseHttpAdapterAllowedHosts,
} = await import("../adapters/http/url-guard.js");
const { testEnvironment } = await import("../adapters/http/test.js");

describe("HTTP adapter URL guard", () => {
  afterEach(() => {
    dnsLookup.mockReset();
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

  it("accepts a public hostname whose DNS is public", async () => {
    dnsLookup.mockResolvedValueOnce([{ address: "203.0.113.10", family: 4 }]);
    const parsed = await assertSafeHttpAdapterUrl("https://agents.example.com/wakeup");
    expect(parsed.hostname).toBe("agents.example.com");
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
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await testEnvironment({
        companyId: "00000000-0000-0000-0000-000000000001",
        adapterType: "http",
        config: { url: "https://public.example/hook" },
      });
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({ method: "HEAD", redirect: "manual" }),
      );
      expect(result.status).toBe("fail");
      expect(result.checks.some((check) => check.code === "http_url_ssrf_blocked" && check.level === "error")).toBe(
        true,
      );
      expect(result.checks.some((check) => check.code === "http_endpoint_probe_failed")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
