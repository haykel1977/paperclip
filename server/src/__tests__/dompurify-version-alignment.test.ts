import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(serverRoot, "..");

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, "utf8"));
}

// dompurify does not export ./package.json: walk up from the resolved entry.
function installedVersion(entry: string): string | undefined {
  for (let dir = path.dirname(entry); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    try {
      const pkg = readJson(path.join(dir, "package.json"));
      if (pkg.name === "dompurify") return pkg.version;
    } catch {
      // keep walking up
    }
  }
  return undefined;
}

describe("dompurify version alignment", () => {
  // SVG uploads are sanitized with DOMPurify. A root pnpm override pinned to an
  // older release silently cancels a dependency bump in server/package.json.
  it("keeps the root pnpm override, the server manifest and the installed package in sync", () => {
    const declared = readJson(path.join(serverRoot, "package.json")).dependencies?.dompurify;
    const override = readJson(path.join(repoRoot, "package.json")).pnpm?.overrides?.dompurify;
    const requireFromServer = createRequire(path.join(serverRoot, "package.json"));
    const installed = installedVersion(requireFromServer.resolve("dompurify"));

    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
    expect(override).toBe(declared);
    expect(installed).toBe(declared);
  });
});
