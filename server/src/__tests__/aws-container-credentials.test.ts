import { afterEach, describe, expect, it, vi } from "vitest";
import { createSafeContainerCredentialsProviderFromEnv } from "../aws-container-credentials.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSafeContainerCredentialsProviderFromEnv", () => {
  it("does not override the AWS SDK provider chain without a full container credentials URI", () => {
    expect(createSafeContainerCredentialsProviderFromEnv({})).toBeUndefined();
    expect(createSafeContainerCredentialsProviderFromEnv({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials" })).toBeUndefined();
  });

  it("rejects non-local full container credentials URIs before any network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = createSafeContainerCredentialsProviderFromEnv({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.2/creds",
    });

    await expect(provider?.()).rejects.toThrow("must point to localhost or 127.0.0.1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches localhost container credentials with the configured auth token", async () => {
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      AccessKeyId: "access-key",
      SecretAccessKey: "secret-key",
      Token: "session-token",
      Expiration: expiresAt,
      AccountId: "123456789012",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createSafeContainerCredentialsProviderFromEnv({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://localhost:9911/creds",
      AWS_CONTAINER_AUTHORIZATION_TOKEN: "Bearer metadata-token",
    });

    await expect(provider?.()).resolves.toMatchObject({
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      sessionToken: "session-token",
      accountId: "123456789012",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://localhost:9911/creds");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer metadata-token" },
    });
  });

  it("caches credentials until their expiration window", async () => {
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      AccessKeyId: "access-key",
      SecretAccessKey: "secret-key",
      Token: "session-token",
      Expiration: expiresAt,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createSafeContainerCredentialsProviderFromEnv({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1:9911/creds",
    });

    const first = await provider?.();
    const second = await provider?.();

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
