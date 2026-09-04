import os from "node:os";
import path from "node:path";

const DARWIN_USERS_PREFIX = "/Users/";

export function isForeignDarwinHomePath(
  home: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "darwin") return false;
  const normalized = home.trim().replace(/\\/g, "/");
  return normalized === "/Users" || normalized.startsWith(DARWIN_USERS_PREFIX);
}

export function readUserInfoHomedir(): string | null {
  try {
    return os.userInfo().homedir || null;
  } catch {
    // os.userInfo() throws when the current UID has no /etc/passwd entry
    // (e.g. `docker run --user 1234` with a minimal image).
    return null;
  }
}

export function resolveOpenCodeHomeDir(input: {
  candidates?: Array<string | null | undefined>;
  envHome?: string | null;
  osHomedir?: string | null;
  userInfoHomedir?: string | null;
  tmpdir?: string;
  platform?: NodeJS.Platform;
} = {}): string {
  const platform = input.platform ?? process.platform;
  // Default order matches pre-refactor model discovery: passwd home first so
  // `runuser -u` does not keep a parent HOME like /root. Callers that must
  // honor an explicit adapter `env.HOME` pass `candidates` themselves.
  const ordered = input.candidates ?? [input.userInfoHomedir, input.envHome, input.osHomedir];
  const candidates = ordered.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (isForeignDarwinHomePath(resolved, platform)) continue;
    return resolved;
  }

  return input.tmpdir ?? os.tmpdir();
}

export function resolveProcessOpenCodeHomeDir(): string {
  return resolveOpenCodeHomeDir({
    userInfoHomedir: readUserInfoHomedir(),
    envHome: process.env.HOME,
    osHomedir: os.homedir(),
  });
}
