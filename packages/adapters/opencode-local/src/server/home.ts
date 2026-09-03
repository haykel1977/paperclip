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

export function resolveOpenCodeHomeDir(input: {
  envHome?: string | null;
  osHomedir?: string | null;
  userInfoHomedir?: string | null;
  tmpdir?: string;
  platform?: NodeJS.Platform;
} = {}): string {
  const platform = input.platform ?? process.platform;
  const candidates = [input.envHome, input.osHomedir, input.userInfoHomedir].filter(
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
  let userInfoHomedir: string | null = null;
  try {
    userInfoHomedir = os.userInfo().homedir || null;
  } catch {
    userInfoHomedir = null;
  }
  return resolveOpenCodeHomeDir({
    envHome: process.env.HOME,
    osHomedir: os.homedir(),
    userInfoHomedir,
  });
}
