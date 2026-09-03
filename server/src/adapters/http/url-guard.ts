import { isIP } from "node:net";
import { promises as dns } from "node:dns";

export const HTTP_ADAPTER_ALLOWED_HOSTS_ENV = "PAPERCLIP_HTTP_ADAPTER_ALLOWED_HOSTS";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google",
  "metadata.google.internal",
]);

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

export function parseHttpAdapterAllowedHosts(raw: string | undefined): Set<string> {
  const hosts = new Set<string>();
  if (!raw) return hosts;
  for (const part of raw.split(",")) {
    const host = normalizeHostname(part);
    if (host) hosts.add(host);
  }
  return hosts;
}

export function isBlockedHttpAdapterHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".localhost.localdomain")) return true;
  return false;
}

export function isBlockedHttpAdapterIp(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase();
  if (!trimmed) return true;

  if (trimmed.startsWith("::ffff:")) {
    return isBlockedHttpAdapterIp(trimmed.slice("::ffff:".length));
  }

  const version = isIP(trimmed);
  if (version === 4) {
    const octets = trimmed.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return true;
    }
    const [a, b] = octets;
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 255) return true;
    return false;
  }

  if (version === 6) {
    if (trimmed === "::" || trimmed === "::1") return true;
    if (trimmed.startsWith("fe80:")) return true;
    if (trimmed.startsWith("fc") || trimmed.startsWith("fd")) return true;
    return false;
  }

  return true;
}

export function assertSafeHttpAdapterUrlSync(
  rawUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("HTTP adapter url is not a valid absolute URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`HTTP adapter url protocol not allowed: ${parsed.protocol}`);
  }

  const hostname = normalizeHostname(parsed.hostname);
  const allowed = parseHttpAdapterAllowedHosts(env[HTTP_ADAPTER_ALLOWED_HOSTS_ENV]);
  if (allowed.has(hostname)) {
    return parsed;
  }

  if (isBlockedHttpAdapterHostname(hostname)) {
    throw new Error(`HTTP adapter url host is not allowed: ${hostname}`);
  }

  if (isIP(hostname) && isBlockedHttpAdapterIp(hostname)) {
    throw new Error(`HTTP adapter url resolves to a blocked address: ${hostname}`);
  }

  return parsed;
}

export const HTTP_ADAPTER_FETCH_REDIRECT = "manual" as const;

export class HttpAdapterSsrfError extends Error {
  readonly code = "http_url_ssrf_blocked" as const;

  constructor(message: string) {
    super(message);
    this.name = "HttpAdapterSsrfError";
  }
}

export function httpAdapterFetchInit<T extends RequestInit>(init: T): T & { redirect: "manual" } {
  return { ...init, redirect: HTTP_ADAPTER_FETCH_REDIRECT };
}

export function assertHttpAdapterResponseNotRedirect(res: Response): void {
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    throw new HttpAdapterSsrfError(
      `HTTP adapter refused redirect (${res.status || "opaque"}) to avoid SSRF via Location`,
    );
  }
}

export async function assertSafeHttpAdapterUrl(
  rawUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<URL> {
  const parsed = assertSafeHttpAdapterUrlSync(rawUrl, env);
  const hostname = normalizeHostname(parsed.hostname);
  const allowed = parseHttpAdapterAllowedHosts(env[HTTP_ADAPTER_ALLOWED_HOSTS_ENV]);
  if (allowed.has(hostname) || isIP(hostname)) {
    return parsed;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(
      `HTTP adapter url host could not be resolved: ${hostname} (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  for (const entry of addresses) {
    if (isBlockedHttpAdapterIp(entry.address)) {
      throw new Error(`HTTP adapter url resolves to a blocked address: ${entry.address}`);
    }
  }

  return parsed;
}
