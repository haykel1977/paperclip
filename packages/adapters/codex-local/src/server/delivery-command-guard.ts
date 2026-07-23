import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type NativeDeliveryCommandGuard = {
  env: Record<string, string>;
  directory: string;
  cleanup: () => Promise<void>;
};

const BLOCKED_GH_PR_COMMANDS = "create|merge|close|edit|ready|review";

export async function installNativeDeliveryCommandGuard(
  env: Record<string, string>,
): Promise<NativeDeliveryCommandGuard | null> {
  const lane = (env.PAPERCLIP_DELIVERY_LANE ?? "production").trim().toLowerCase();
  if (lane !== "disabled" || process.platform === "win32") return null;

  const originalPath = env.PATH ?? process.env.PATH ?? "";
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-delivery-guard-"));
  const guardMessage =
    "[paperclip] native git/PR delivery is disabled; Quantum PaperclipJob owns commit, push, and PR creation";

  const gitWrapper = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "push" ]]; then
  printf '%s\n' '${guardMessage}' >&2
  exit 88
fi
PATH="\${PAPERCLIP_DELIVERY_GUARD_ORIGINAL_PATH:?}" exec git "$@"
`;

  const ghWrapper = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "pr" && "\${2:-}" =~ ^(${BLOCKED_GH_PR_COMMANDS})$ ]]; then
  printf '%s\n' '${guardMessage}' >&2
  exit 88
fi
if [[ "\${1:-}" == "api" ]]; then
  for arg in "$@"; do
    case "$arg" in
      -X|--method|-f|--field|-F|--raw-field|--input|-X*|--method=*)
        printf '%s\n' '${guardMessage}' >&2
        exit 88
        ;;
    esac
  done
fi
PATH="\${PAPERCLIP_DELIVERY_GUARD_ORIGINAL_PATH:?}" exec gh "$@"
`;

  await Promise.all([
    fs.writeFile(path.join(directory, "git"), gitWrapper, { mode: 0o755 }),
    fs.writeFile(path.join(directory, "gh"), ghWrapper, { mode: 0o755 }),
  ]);

  const guardedEnv = {
    ...env,
    PATH: `${directory}${path.delimiter}${originalPath}`,
    PAPERCLIP_DELIVERY_GUARD_ORIGINAL_PATH: originalPath,
    PAPERCLIP_NATIVE_DELIVERY_BLOCKED: "1",
  };
  delete guardedEnv.GH_TOKEN;
  delete guardedEnv.GITHUB_TOKEN;

  return {
    directory,
    env: guardedEnv,
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
}
