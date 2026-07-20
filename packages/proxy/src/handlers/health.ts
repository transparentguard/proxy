/**
 * TransparentGuard Proxy — Health & Readiness Handlers
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { TransparentGuard } from "@transparentguard/runtime";

export function handleHealth(res: ServerResponse): void {
  const body = JSON.stringify({ status: "ok", service: "transparentguard-proxy" });
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function handleReady(res: ServerResponse, tg: TransparentGuard | null): void {
  if (!tg) {
    const body = JSON.stringify({ status: "initializing" });
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }
  const policy = tg.getPolicy();
  const body = JSON.stringify({
    status: "ready",
    policy: policy.name,
    policy_version: policy.tps_version,
  });
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function handleNotFound(req: IncomingMessage, res: ServerResponse): void {
  const body = JSON.stringify({
    error: {
      message: `Route not found: ${req.method ?? "?"} ${req.url ?? "/"}`,
      type: "invalid_request_error",
      code: "not_found",
    },
  });
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(body);
}
