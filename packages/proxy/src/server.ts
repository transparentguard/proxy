/**
 * TransparentGuard Proxy — HTTP Server
 *
 * Plain Node.js http.createServer — no framework.
 * Routes:
 *   GET  /health         → 200 OK (liveness probe)
 *   GET  /ready          → 200 if policy loaded, 503 if not
 *   POST /v1/chat/completions   → OpenAI handler
 *   POST /v1/messages           → Anthropic handler
 *   POST /v1/*                  → OpenAI handler (catch-all for other v1 paths)
 *   *    *               → 404
 */

import http from "node:http";
import crypto from "node:crypto";
import type { TransparentGuard } from "@transparentguard/runtime";
import type { ProxyConfig, RequestContext } from "./types.js";
import { handleOpenAI } from "./handlers/openai.js";
import { handleAnthropic } from "./handlers/anthropic.js";
import { handleHealth, handleReady, handleNotFound } from "./handlers/health.js";

function makeRequestId(): string {
  return `tgr_${crypto.randomBytes(10).toString("hex")}`;
}

/**
 * Extract the API key for forwarding to the upstream.
 * Priority:
 *   1. Config override (--upstream-api-key or UPSTREAM_API_KEY)
 *   2. Authorization: Bearer <key> header from the client request
 *   3. x-api-key header (Anthropic convention)
 */
function extractUpstreamApiKey(
  req: http.IncomingMessage,
  configOverride: string | undefined,
): string {
  if (configOverride) return configOverride;

  const auth = req.headers["authorization"];
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }

  const apiKey = req.headers["x-api-key"];
  if (apiKey) return Array.isArray(apiKey) ? apiKey[0] ?? "" : apiKey;

  return "";
}

function isAnthropicPath(url: string): boolean {
  return url === "/v1/messages" || url.startsWith("/v1/messages?");
}

function isOpenAIPath(url: string): boolean {
  return url.startsWith("/v1/");
}

export function startServer(config: ProxyConfig): http.Server {
  const { tg, upstream, upstreamApiKey, port, logLevel } = config;

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // Health checks (no auth, no OTEL overhead)
    if (method === "GET" && url === "/health") {
      handleHealth(res);
      return;
    }
    if (method === "GET" && url === "/ready") {
      handleReady(res, tg as TransparentGuard | null);
      return;
    }

    // All other paths require a POST
    if (method !== "POST") {
      handleNotFound(req, res);
      return;
    }

    const apiKey = extractUpstreamApiKey(req, upstreamApiKey);
    if (!apiKey) {
      const body = JSON.stringify({
        error: {
          message: "No API key found. Send Authorization: Bearer <key> or set --upstream-api-key.",
          type: "authentication_error",
          code: "no_api_key",
        },
      });
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    const ctx: RequestContext = {
      requestId: makeRequestId(),
      method,
      path: url,
      upstreamApiKey: apiKey,
      startMs: Date.now(),
    };

    if (logLevel === "debug" || logLevel === "info") {
      console.log(`[TG] ${method} ${url} → request_id=${ctx.requestId}`);
    }

    const finish = (): void => {
      if (logLevel === "debug") {
        console.log(`[TG] ${ctx.requestId} done in ${Date.now() - ctx.startMs}ms`);
      }
    };

    res.on("finish", finish);
    res.on("close", finish);

    if (isAnthropicPath(url)) {
      void handleAnthropic(req, res, ctx, tg, upstream);
    } else if (isOpenAIPath(url)) {
      void handleOpenAI(req, res, ctx, tg, upstream);
    } else {
      handleNotFound(req, res);
    }
  });

  server.listen(port, () => {
    console.log(`[TransparentGuard] Proxy listening on port ${port}`);
    console.log(`[TransparentGuard] Upstream: ${upstream}`);
    console.log(`[TransparentGuard] Policy: ${tg.getPolicy().name}`);
  });

  return server;
}
