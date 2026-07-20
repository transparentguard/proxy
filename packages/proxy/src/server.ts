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
import { verifyUnkey } from "./middleware/unkey.js";

function makeRequestId(): string {
  return `tgr_${crypto.randomBytes(10).toString("hex")}`;
}

/**
 * Extract the customer's TransparentGuard API key from the request headers.
 * This is what gets verified with Unkey.
 *   1. Authorization: Bearer <key>
 *   2. x-api-key header (Anthropic convention)
 */
function extractTgApiKey(req: http.IncomingMessage): string {
  const auth = req.headers["authorization"];
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  const apiKey = req.headers["x-api-key"];
  if (apiKey) return Array.isArray(apiKey) ? apiKey[0] ?? "" : apiKey;
  return "";
}

/**
 * Determine the API key to forward to the upstream (OpenAI / Anthropic).
 * Priority:
 *   1. Config override (UPSTREAM_API_KEY env var or --upstream-api-key flag)
 *   2. Customer's key from the request (BYOK fallback)
 */
function resolveUpstreamApiKey(
  customerKey: string,
  configOverride: string | undefined,
): string {
  return configOverride ?? customerKey;
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

    void (async () => {
      const tgKey = extractTgApiKey(req);

      // Verify the customer's TG key with Unkey (if configured)
      const unkeyResult = await verifyUnkey(tgKey);

      if (unkeyResult === null) {
        // Unkey not configured — require at least some key to be present
        if (!tgKey) {
          const body = JSON.stringify({
            error: {
              message: "No API key found. Send Authorization: Bearer <key>.",
              type: "authentication_error",
              code: "no_api_key",
            },
          });
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(body);
          return;
        }
      } else if (!unkeyResult.valid) {
        const body = JSON.stringify({
          error: {
            message: "Invalid or expired API key.",
            type: "authentication_error",
            code: unkeyResult.errorCode ?? "invalid_api_key",
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
        upstreamApiKey: resolveUpstreamApiKey(tgKey, upstreamApiKey),
        startMs: Date.now(),
        tgApiKey: tgKey,
        tgKeyId: unkeyResult?.keyId ?? "",
        tier: unkeyResult?.tier ?? "free",
      };

      if (logLevel === "debug" || logLevel === "info") {
        console.log(`[TG] ${method} ${url} → request_id=${ctx.requestId} tier=${ctx.tier}`);
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
    })();
  });

  server.listen(port, () => {
    console.log(`[TransparentGuard] Proxy listening on port ${port}`);
    console.log(`[TransparentGuard] Upstream: ${upstream}`);
    console.log(`[TransparentGuard] Policy: ${tg.getPolicy().name}`);
  });

  return server;
}
