import { isIP } from "node:net";
import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";

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

export type SafeHttpAdapterTarget = {
  url: URL;
  /** Address used for the TCP connect so fetch cannot re-resolve DNS. */
  pinnedAddress: string;
};

export type HttpAdapterFetchInit = RequestInit & {
  pinnedAddress?: string | null;
};

/** Test-only override. Production code must leave this null. */
export const httpAdapterFetchHook: {
  current: ((url: URL, init: HttpAdapterFetchInit) => Promise<Response>) | null;
} = { current: null };

export function pinnedHttpAdapterLookup(address: string): NonNullable<https.RequestOptions["lookup"]> {
  const family = (isIP(address) === 6 ? 6 : 4) as 4 | 6;
  return ((
    _hostname: string,
    options: unknown,
    callback?: (
      err: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ) => {
    const cb = (typeof options === "function" ? options : callback)!;
    const opts = typeof options === "object" && options !== null ? (options as { all?: boolean }) : {};
    if (opts.all) {
      cb(null, [{ address, family }]);
      return;
    }
    cb(null, address, family);
  }) as NonNullable<https.RequestOptions["lookup"]>;
}

function toNodeHeaders(headersInit?: HeadersInit): http.OutgoingHttpHeaders {
  const headers = new Headers(headersInit);
  const out: http.OutgoingHttpHeaders = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function requestBody(init: RequestInit): string | Buffer | undefined {
  if (init.body == null) return undefined;
  if (typeof init.body === "string") return init.body;
  if (init.body instanceof Uint8Array) return Buffer.from(init.body);
  throw new Error("HTTP adapter only supports string or buffer request bodies");
}

export function createHttpAdapterAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

export function httpAdapterUrlBasicAuth(url: URL): string | undefined {
  if (url.username === "" && url.password === "") return undefined;
  return `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
}

async function fetchPinnedToAddress(
  url: URL,
  init: RequestInit,
  pinnedAddress: string,
): Promise<Response> {
  if (init.signal?.aborted) {
    throw createHttpAdapterAbortError(init.signal.reason);
  }

  const lib = url.protocol === "https:" ? https : http;
  const body = requestBody(init);
  const headers = toNodeHeaders(init.headers);
  if (headers.host == null && headers.Host == null) {
    headers.host = url.host;
  }
  const hasAuthHeader = headers.authorization != null || headers.Authorization != null;
  const auth = hasAuthHeader ? undefined : httpAdapterUrlBasicAuth(url);

  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = (response: Response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      if (init.signal?.aborted) {
        reject(createHttpAdapterAbortError(init.signal.reason));
        return;
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: (init.method ?? "GET").toString(),
        headers,
        auth,
        signal: init.signal,
        lookup: pinnedHttpAdapterLookup(pinnedAddress),
      },
      (incoming) => {
        if (init.signal?.aborted) {
          incoming.destroy();
          fail(createHttpAdapterAbortError(init.signal.reason));
          return;
        }
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () => {
          if (init.signal?.aborted) {
            fail(createHttpAdapterAbortError(init.signal.reason));
            return;
          }
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (value == null) continue;
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(key, item);
            } else {
              responseHeaders.set(key, value);
            }
          }
          const status = incoming.statusCode ?? 0;
          const rawBody = Buffer.concat(chunks);
          const responseBody =
            status === 204 || status === 205 || status === 304 || rawBody.length === 0
              ? null
              : rawBody;
          try {
            succeed(
              new Response(responseBody, {
                status: status === 0 ? 200 : status,
                statusText: incoming.statusMessage ?? "",
                headers: responseHeaders,
              }),
            );
          } catch (err) {
            fail(err);
          }
        });
        incoming.on("error", fail);
      },
    );
    req.on("error", fail);
    if (body != null) req.write(body);
    req.end();
  });
}

export async function httpAdapterFetch(url: URL, init: HttpAdapterFetchInit = {}): Promise<Response> {
  if (httpAdapterFetchHook.current) {
    return httpAdapterFetchHook.current(url, httpAdapterFetchInit(init));
  }
  const { pinnedAddress, ...rest } = init;
  const fetchInit = httpAdapterFetchInit(rest);
  if (!pinnedAddress) {
    return fetch(url, fetchInit);
  }
  return fetchPinnedToAddress(url, fetchInit, pinnedAddress);
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
): Promise<SafeHttpAdapterTarget> {
  const parsed = assertSafeHttpAdapterUrlSync(rawUrl, env);
  const hostname = normalizeHostname(parsed.hostname);
  if (isIP(hostname)) {
    return { url: parsed, pinnedAddress: hostname };
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(
      `HTTP adapter url host could not be resolved: ${hostname} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (addresses.length === 0) {
    throw new Error(`HTTP adapter url host could not be resolved: ${hostname}`);
  }

  const allowed = parseHttpAdapterAllowedHosts(env[HTTP_ADAPTER_ALLOWED_HOSTS_ENV]);
  if (!allowed.has(hostname)) {
    for (const entry of addresses) {
      if (isBlockedHttpAdapterIp(entry.address)) {
        throw new Error(`HTTP adapter url resolves to a blocked address: ${entry.address}`);
      }
    }
  }

  return { url: parsed, pinnedAddress: addresses[0].address };
}
