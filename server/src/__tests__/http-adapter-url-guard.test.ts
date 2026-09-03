import { afterEach, describe, expect, it, vi } from "vitest";

const dnsLookup = vi.fn();

vi.mock("node:dns", () => ({
  promises: {
    lookup: (...args: unknown[]) => dnsLookup(...args),
  },
}));

const {
  assertSafeHttpAdapterUrl,
  assertSafeHttpAdapterUrlSync,
  isBlockedHttpAdapterHostname,
  isBlockedHttpAdapterIp,
  parseHttpAdapterAllowedHosts,
} = await import("../adapters/http/url-guard.js");

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
});
