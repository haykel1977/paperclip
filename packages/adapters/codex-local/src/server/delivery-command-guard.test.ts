import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installNativeDeliveryCommandGuard } from "./delivery-command-guard.js";

const tempDirs: string[] = [];

function makeFakeBinary(directory: string, name: string, output: string) {
  const file = path.join(directory, name);
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
}

describe("installNativeDeliveryCommandGuard", () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does nothing outside the disabled delivery lane", async () => {
    await expect(
      installNativeDeliveryCommandGuard({ PATH: process.env.PATH ?? "" }),
    ).resolves.toBeNull();
  });

  it("blocks native push and PR mutations while preserving read commands", async () => {
    const fakeBin = mkdtempSync(path.join(os.tmpdir(), "paperclip-delivery-real-bin-"));
    tempDirs.push(fakeBin);
    makeFakeBinary(fakeBin, "git", "REAL_GIT");
    makeFakeBinary(fakeBin, "gh", "REAL_GH");

    const originalPath = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
    const guard = await installNativeDeliveryCommandGuard({
      PATH: originalPath,
      PAPERCLIP_DELIVERY_LANE: "disabled",
      GH_TOKEN: "write-token",
      GITHUB_TOKEN: "write-token",
    });

    expect(guard).not.toBeNull();
    if (!guard) return;
    tempDirs.push(guard.directory);
    expect(guard.env.GH_TOKEN).toBeUndefined();
    expect(guard.env.GITHUB_TOKEN).toBeUndefined();

    const gitPush = spawnSync(path.join(guard.directory, "git"), ["push", "origin", "HEAD"], {

      env: guard.env,
      encoding: "utf8",
    });
    expect(gitPush.status).toBe(88);
    expect(gitPush.stderr).toContain("native git/PR delivery is disabled");

    const prCreate = spawnSync(path.join(guard.directory, "gh"), ["pr", "create"], {
      env: guard.env,
      encoding: "utf8",
    });
    expect(prCreate.status).toBe(88);

    const apiMutation = spawnSync(path.join(guard.directory, "gh"), ["api", "repos/o/r/pulls", "-f", "title=x"], {
      env: guard.env,
      encoding: "utf8",
    });
    expect(apiMutation.status).toBe(88);

    expect(
      execFileSync(path.join(guard.directory, "git"), ["status"], {
        env: guard.env,
        encoding: "utf8",
      }).trim(),
    ).toBe("REAL_GIT");
    expect(
      execFileSync(path.join(guard.directory, "gh"), ["pr", "view"], {
        env: guard.env,
        encoding: "utf8",
      }).trim(),
    ).toBe("REAL_GH");

    await guard.cleanup();
    expect(existsSync(guard.directory)).toBe(false);
    tempDirs.pop();
  });
});
