/**
 * Shared attachment content-type configuration.
 *
 * By default a curated set of image/document/text/media types are allowed. Set the
 * `PAPERCLIP_ALLOWED_ATTACHMENT_TYPES` environment variable to a
 * comma-separated list of MIME types or wildcard patterns to expand the
 * allowed set for routes that use this allowlist.
 *
 * Examples:
 *   PAPERCLIP_ALLOWED_ATTACHMENT_TYPES=image/*,application/pdf
 *   PAPERCLIP_ALLOWED_ATTACHMENT_TYPES=image/*,application/pdf,text/*
 *
 * Supported pattern syntax:
 *   - Exact types:   "application/pdf"
 *   - Wildcards:     "image/*"  or  "application/vnd.openxmlformats-officedocument.*"
 */
import {
  DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES,
  MAX_COMPANY_ATTACHMENT_MAX_BYTES,
} from "@paperclipai/shared";

export const DEFAULT_ALLOWED_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/zip",
  "text/markdown",
  "text/plain",
  "application/json",
  "text/csv",
  "text/html",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
];

export const DEFAULT_ATTACHMENT_CONTENT_TYPE = "application/octet-stream";
export const SVG_CONTENT_TYPE = "image/svg+xml";
export const INLINE_ATTACHMENT_TYPES: readonly string[] = [
  "image/*",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
];

/**
 * Parse a comma-separated list of MIME type patterns into a normalised array.
 * Returns the default image-only list when the input is empty or undefined.
 */
export function parseAllowedTypes(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_ALLOWED_TYPES];
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_ALLOWED_TYPES];
}

/**
 * Check whether `contentType` matches any entry in `allowedPatterns`.
 *
 * Supports exact matches ("application/pdf") and wildcard / prefix
 * patterns ("image/*", "application/vnd.openxmlformats-officedocument.*").
 */
export function matchesContentType(contentType: string, allowedPatterns: string[]): boolean {
  const ct = contentType.toLowerCase();
  return allowedPatterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith("/*") || pattern.endsWith(".*")) {
      return ct.startsWith(pattern.slice(0, -1));
    }
    return ct === pattern;
  });
}

export function normalizeContentType(contentType: string | null | undefined): string {
  const normalized = (contentType ?? "").trim().toLowerCase();
  return normalized || DEFAULT_ATTACHMENT_CONTENT_TYPE;
}

function bytesStartWith(body: Uint8Array, signature: readonly number[]): boolean {
  if (body.length < signature.length) return false;
  return signature.every((byte, index) => body[index] === byte);
}

function bufferAscii(body: Uint8Array, start: number, length: number): string {
  return Buffer.from(body.subarray(start, start + length)).toString("ascii");
}

export function detectAttachmentContentType(body: Uint8Array): string | null {
  if (bytesStartWith(body, [0x4d, 0x5a])) return "application/x-msdownload";
  if (bytesStartWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytesStartWith(body, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bufferAscii(body, 0, 6) === "GIF87a" || bufferAscii(body, 0, 6) === "GIF89a") return "image/gif";
  if (bufferAscii(body, 0, 4) === "RIFF" && bufferAscii(body, 8, 4) === "WEBP") return "image/webp";
  if (bytesStartWith(body, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (
    bytesStartWith(body, [0x50, 0x4b, 0x03, 0x04]) ||
    bytesStartWith(body, [0x50, 0x4b, 0x05, 0x06]) ||
    bytesStartWith(body, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return "application/zip";
  }
  if (bytesStartWith(body, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (body.length >= 12 && bufferAscii(body, 4, 4) === "ftyp") return "video/mp4";

  const prefix = Buffer.from(body.subarray(0, 512)).toString("utf8").trimStart().toLowerCase();
  if (prefix.startsWith("<svg") || (prefix.startsWith("<?xml") && prefix.includes("<svg"))) return SVG_CONTENT_TYPE;
  if (
    prefix.startsWith("<!doctype html") ||
    prefix.startsWith("<html") ||
    prefix.startsWith("<head") ||
    prefix.startsWith("<body") ||
    prefix.startsWith("<script")
  ) {
    return "text/html";
  }

  return null;
}

export function isAttachmentContentCompatible(contentType: string, body: Uint8Array): boolean {
  const declared = normalizeContentType(contentType);
  const detected = detectAttachmentContentType(body);
  if (!detected) return true;
  if (detected === "application/x-msdownload") return false;
  if (declared === DEFAULT_ATTACHMENT_CONTENT_TYPE) return true;
  if (detected === "image/jpeg") return declared === "image/jpeg" || declared === "image/jpg";
  if (detected === "application/zip") {
    return declared === "application/zip" || declared.startsWith("application/vnd.openxmlformats-officedocument.");
  }
  return declared === detected;
}

export function isInlineAttachmentContentType(contentType: string): boolean {
  return matchesContentType(contentType, [...INLINE_ATTACHMENT_TYPES]);
}

// ---------- Module-level singletons read once at startup ----------

const allowedPatterns: string[] = parseAllowedTypes(
  process.env.PAPERCLIP_ALLOWED_ATTACHMENT_TYPES,
);

/** Convenience wrapper using the process-level allowed list. */
export function isAllowedContentType(contentType: string): boolean {
  return matchesContentType(contentType, allowedPatterns);
}

export const MAX_ATTACHMENT_BYTES =
  Number(process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES) || 10 * 1024 * 1024;

export function normalizeIssueAttachmentMaxBytes(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Math.min(DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES, MAX_ATTACHMENT_BYTES);
  }
  return Math.min(Math.floor(value), MAX_COMPANY_ATTACHMENT_MAX_BYTES, MAX_ATTACHMENT_BYTES);
}
