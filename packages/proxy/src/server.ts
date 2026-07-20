/**
 * TransparentGuard Proxy — HTTP Server
 *
 * Plain Node.js http.createServer — no framework.
 * Routes:
 *   GET  /health         → 200 OK (liveness probe)
 *   GET  /ready          → 200 if policy loaded, 503 if not
 *   POST /v1/chat/completions   → OpenAI-compatible handler
 *   POST /v1/messages           → Anthropic handler
 *   POST /v1/*                  → OpenAI-compatible catch-all (Groq, Mistral, etc.)
 *   *    *               → 404
 *
 * Auth headers:
 *   X-TG-Key: <transparentguard-key>   — verified against Unkey (required)
 *   Authorization: Bearer <provider-key> OR x-api-key: <provider-key> — forwarded to the AI provider as-is
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
 * Extract the customer's TransparentGuard subscription key.
 * Sent in the custom X-TG-Key header — verified against Unkey.
 */
function extractTgApiKey(req: http.IncomingMessage): string {
  const key = req.headers["x-tg-key"];
  if (key) return Array.isArray(key) ? key[0] ?? "" : key;
  return "";
}

/**
 * Extract the AI provider key to forward upstream.
 * Customers send their own provider key exactly as they would to the provider directly:
 *   - OpenAI / OpenAI-compatible (Groq, Mistral, Together, etc.): Authorization: Bearer <key>
 *   - Anthropic: x-api-key: <key>
 * The proxy forwards this key to the upstream provider untouched.
 */
function extractProviderKey(req: http.IncomingMessage): string {
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

    void (async () => {
      const tgKey = extractTgApiKey(req);
      const providerKey = extractProviderKey(req);

      // Verify the customer's TransparentGuard key with Unkey (if configured)
      const unkeyResult = await verifyUnkey(tgKey);

      if (unkeyResult === null) {
        // Unkey not configured — require at least a TG key to be present
        if (!tgKey) {
          const body = JSON.stringify({
            error: {
              message: "No TransparentGuard API key found. Send X-TG-Key: <key> in your request.",
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
            message: "Invalid or expired TransparentGuard API key.",
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
        // upstreamApiKey: config override takes priority, otherwise forward customer's provider key
        upstreamApiKey: upstreamApiKey ?? providerKey,
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
