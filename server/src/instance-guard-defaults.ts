import os from "node:os";
import path from "node:path";

export const CANONICAL_INSTANCE_VALUE = "canonical";
export const SECONDARY_HTTP_PORT = "3200";
export const SECONDARY_EMBEDDED_PG_PORT = "54330";

export type NonCanonicalInstanceDefaults = {
  PORT?: string;
  PAPERCLIP_HOME?: string;
  PAPERCLIP_EMBEDDED_PG_PORT?: string;
};

export function applyNonCanonicalInstanceDefaults(
  env: NodeJS.ProcessEnv,
  opts?: { homedir?: string },
): { applied: boolean; defaults: NonCanonicalInstanceDefaults } {
  if (env.PAPERCLIP_INSTANCE === CANONICAL_INSTANCE_VALUE) {
    return { applied: false, defaults: {} };
  }

  const defaults: NonCanonicalInstanceDefaults = {};
  if (!env.PORT) {
    env.PORT = SECONDARY_HTTP_PORT;
    defaults.PORT = SECONDARY_HTTP_PORT;
  }
  if (!env.PAPERCLIP_HOME) {
    const home = path.join(opts?.homedir ?? os.homedir(), ".paperclip-dyad");
    env.PAPERCLIP_HOME = home;
    defaults.PAPERCLIP_HOME = home;
  }
  // Preserve an explicit port. Only default when unset.
  if (!env.PAPERCLIP_EMBEDDED_PG_PORT) {
    env.PAPERCLIP_EMBEDDED_PG_PORT = SECONDARY_EMBEDDED_PG_PORT;
    defaults.PAPERCLIP_EMBEDDED_PG_PORT = SECONDARY_EMBEDDED_PG_PORT;
  }

  return { applied: true, defaults };
}
