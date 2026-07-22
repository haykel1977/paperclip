import type { Request } from "express";

export function trustProxyHeaders(): boolean {
  return process.env.PAPERCLIP_TRUST_PROXY_HEADERS === "true";
}

function firstForwardedValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

export function requestHost(req: Request): string | undefined {
  if (trustProxyHeaders()) {
    const forwardedHost = firstForwardedValue(req.header("x-forwarded-host"));
    if (forwardedHost) return forwardedHost;
  }
  return req.header("host")?.trim() || undefined;
}

export function requestProtocol(req: Request): string {
  if (trustProxyHeaders()) {
    const forwardedProto = firstForwardedValue(req.header("x-forwarded-proto"));
    if (forwardedProto) return forwardedProto;
  }
  return req.protocol || "http";
}
