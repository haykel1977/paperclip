import { chmodSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDeliveryTokenFile } from "./delivery-token.js";

const roots: string[] = [];
const repo = "Beyn-SOLIDUS/quantum";
const token = `ghs_${"test_fixture_A".repeat(3)}`;
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "delivery-token-"));
  roots.push(dir);
  const file = path.join(dir, "delivery-token.json");
  const data = { token, repository: repo, expires_at: new Date(Date.now() + 3600_000).toISOString(), ...overrides };
  writeFileSync(file, JSON.stringify(data), { mode: 0o640 });
  return { file, data };
}

describe("delivery token file", () => {
  it("accepts the long stateless installation-token format", async () => {
    const stateless = `ghs_123_${"jwt_header".repeat(30)}.${"jwt-payload".repeat(90)}.jwt_signature`;
    const { file } = fixture({ token: stateless });
    expect(await readDeliveryTokenFile(file, repo)).toBe(stateless);
  });

  it("sees an atomic replacement on its next read", async () => {
    const { file, data } = fixture();
    expect(await readDeliveryTokenFile(file, repo.toLowerCase())).toBe(token);
    const next = `ghs_${"test_fixture_B".repeat(3)}`;
    writeFileSync(`${file}.next`, JSON.stringify({ ...data, token: next }), { mode: 0o640 });
    renameSync(`${file}.next`, file);
    expect(await readDeliveryTokenFile(file, repo)).toBe(next);
  });

  it.each([-60_000, 0, 240_000])("blocks expired or near-expiry tokens (%s ms)", async (remaining) => {
    const { file } = fixture({ expires_at: new Date(Date.now() + remaining).toISOString() });
    await expect(readDeliveryTokenFile(file, repo)).rejects.toThrow("bot_token_file_expired_or_expiring");
  });

  it.each([{ token: "operator-pat" }, { expires_at: "invalid" }, { token: `${token}\n` }])(
    "rejects malformed credentials without disclosing their contents", async (overrides) => {
      const { file } = fixture(overrides);
      await expect(readDeliveryTokenFile(file, repo)).rejects.toThrow(/^bot_token_file_invalid$/);
    },
  );

  it("rejects another repository's file", async () => {
    const { file } = fixture({ repository: "another/company" });
    await expect(readDeliveryTokenFile(file, repo)).rejects.toThrow("bot_token_file_repository_mismatch");
  });

  it.each([0o644, 0o660, 0o740])("rejects unsafe file permissions (%s)", async (mode) => {
    const { file } = fixture();
    chmodSync(file, mode);
    await expect(readDeliveryTokenFile(file, repo)).rejects.toThrow("bot_token_file_unsafe");
  });

  it("rejects missing files, symlinks, oversized files and invalid JSON", async () => {
    const { file } = fixture();
    await expect(readDeliveryTokenFile(`${file}.missing`, repo)).rejects.toThrow("bot_token_file_unreadable");
    symlinkSync(file, `${file}.link`);
    await expect(readDeliveryTokenFile(`${file}.link`, repo)).rejects.toThrow("bot_token_file_unreadable");
    writeFileSync(file, "x".repeat(17 * 1024));
    await expect(readDeliveryTokenFile(file, repo)).rejects.toThrow("bot_token_file_unsafe");
    writeFileSync(file, `{"token":"${token}`);
    await expect(readDeliveryTokenFile(file, repo)).rejects.toThrow(/^bot_token_file_invalid$/);
  });

  it("requires an absolute file path", async () => {
    await expect(readDeliveryTokenFile("delivery-token.json", repo)).rejects.toThrow("bot_token_file_absolute_path_required");
  });
});
