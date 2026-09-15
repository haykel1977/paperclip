import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

// Delivery subprocesses currently have a 120s timeout. Leave time for shutdown
// and clock skew, and re-read before each command after potentially long gates.
const MIN_VALIDITY_MS = 5 * 60 * 1000;
const MAX_FILE_BYTES = 16 * 1024;

export class DeliveryTokenError extends Error {}

export async function readDeliveryTokenFile(file: string, repo: string): Promise<string> {
  if (!path.isAbsolute(file)) throw new DeliveryTokenError("bot_token_file_absolute_path_required");
  let handle;
  let raw: string;
  try {
    // A directory mount lets an atomic rename become visible on the next open.
    // Do not follow a final symlink or block on a substituted FIFO.
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o137) !== 0 || stat.size > MAX_FILE_BYTES) {
      throw new DeliveryTokenError("bot_token_file_unsafe");
    }
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_FILE_BYTES) throw new DeliveryTokenError("bot_token_file_unsafe");
    raw = buffer.toString("utf8", 0, bytesRead);
  } catch (error) {
    if (error instanceof DeliveryTokenError) throw error;
    throw new DeliveryTokenError("bot_token_file_unreadable");
  } finally {
    await handle?.close();
  }

  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new DeliveryTokenError("bot_token_file_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeliveryTokenError("bot_token_file_invalid");
  }
  const record = value as Record<string, unknown>;
  // Installation tokens are opaque. GitHub also issues ghs_APPID_JWT tokens;
  // these contain dots/hyphens and are much longer than the legacy format.
  if (typeof record.token !== "string" || !/^ghs_[A-Za-z0-9_.-]+$/.test(record.token)
    || typeof record.expires_at !== "string" || !Number.isFinite(Date.parse(record.expires_at))) {
    throw new DeliveryTokenError("bot_token_file_invalid");
  }
  if (typeof record.repository !== "string" || record.repository.toLowerCase() !== repo.toLowerCase()) {
    throw new DeliveryTokenError("bot_token_file_repository_mismatch");
  }
  if (Date.parse(record.expires_at) - Date.now() <= MIN_VALIDITY_MS) {
    throw new DeliveryTokenError("bot_token_file_expired_or_expiring");
  }
  return record.token;
}
