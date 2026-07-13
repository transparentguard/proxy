/**
 * TransparentGuard Proxy — OpenAI Handler
 *
 * Handles POST /v1/chat/completions (and any other /v1/* paths).
 * Runs pre-request policy evaluation, forwards to upstream, runs post-response
 * policy evaluation, then returns the (possibly redacted or blocked) response.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { TransparentGuard } from "@transparentguard/runtime";
import type {
  OpenAIChatBody,
  OpenAIChatCompletion,
  OpenAIError,
  RequestContext,
} from "../types.js";
import { callUpstream } from "../upstream/client.js";
import {
  parseSseLines,
  assembleContent,
  startSseResponse,
  emitSseChunks,
  emitRedactedSseChunks,
} from "../streaming.js";
import {
  getTracer,
  SpanStatusCode,
  SpanKind,
} from "../telemetry.js";

// ---------------------------------------------------------------------------
// Body reading helper
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Error response helpers
// ---------------------------------------------------------------------------

function sendOpenAIError(
  res: ServerResponse,
  status: number,
  message: string,
  type = "invalid_request_error",
  code = "policy_violation",
): void {
  const body: OpenAIError = { error: { message, type, code, param: null } };
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

function sendSseBlock(res: ServerResponse, message: string, requestId: string): void {
  startSseResponse(res, { "X-TransparentGuard-Request-ID": requestId });
  const blockChunk = {
    id: `tg-block-${requestId}`,
    object: "chat.completion.chunk",
    model: "blocked",
    choices: [{
      index: 0,
      delta: { content: message },
      finish_reason: "stop",
    }],
  };
  res.write(`data: ${JSON.stringify(blockChunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleOpenAI(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  tg: TransparentGuard,
  upstream: string,
): Promise<void> {
  const tracer = getTracer();

  await tracer.startActiveSpan(
    `POST ${ctx.path}`,
    { kind: SpanKind.SERVER },
    async (rootSpan) => {
      try {
        rootSpan.setAttributes({
          "http.method": "POST",
          "http.route": ctx.path,
          "tg.request_id": ctx.requestId,
        });

        // ------------------------------------------------------------------
        // 1. Parse request body
        // ------------------------------------------------------------------
        let rawBody: string;
        try {
          rawBody = await readBody(req);
        } catch (err) {
          sendOpenAIError(res, 400, `Failed to read request body: ${String(err)}`, "invalid_request_error", "bad_request");
          rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: "body read failed" });
          rootSpan.end();
          return;
        }

        let chatBody: OpenAIChatBody;
        try {
          chatBody = JSON.parse(rawBody) as OpenAIChatBody;
        } catch {
          sendOpenAIError(res, 400, "Request body is not valid JSON.", "invalid_request_error", "bad_request");
          rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: "JSON parse failed" });
          rootSpan.end();
          return;
        }

        rootSpan.setAttributes({
          "llm.vendor": "openai",
          "llm.request.model": chatBody.model ?? "unknown",
        });

        // ------------------------------------------------------------------
        // 2. Pre-request evaluation
        // ------------------------------------------------------------------
        const VALID_ROLES = new Set(["system", "user", "assistant", "tool"]);
        const requestPayload = {
          messages: (chatBody.messages ?? []).map((m) => ({
            role: (VALID_ROLES.has(m.role) ? m.role : "user") as "system" | "user" | "assistant" | "tool",
            content: m.content ?? null,
          })),
          provider: "openai" as const,
          model: chatBody.model,
        };

        let preResult = await tracer.startActiveSpan(
          "tg.evaluate.pre_request",
          async (preSpan) => {
            try {
              const result = await tg.evaluate("pre-request", requestPayload, {
                requestId: ctx.requestId,
              });
              preSpan.setAttributes({
                "tg.outcome": result.allowed ? "allowed" : "blocked",
                "tg.violations": result.violations.length,
              });
              if (!result.allowed) {
                preSpan.setStatus({ code: SpanStatusCode.ERROR, message: "blocked" });
              }
              return result;
            } finally {
              preSpan.end();
            }
          },
        );

        if (!preResult.allowed) {
          const blockMsg =
            preResult.violations[0]?.detail ??
            "Request blocked by TransparentGuard policy.";

          if (chatBody.stream) {
            sendSseBlock(res, blockMsg, ctx.requestId);
          } else {
            sendOpenAIError(res, 400, blockMsg, "policy_violation", "policy_violation");
          }
          rootSpan.setAttributes({ "tg.pre_request.outcome": "blocked" });
          rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: "pre-request blocked" });
          rootSpan.end();
          return;
        }

        rootSpan.setAttributes({ "tg.pre_request.outcome": "allowed" });

        // Apply any redactions to the outgoing messages
        const evaluatedMessages =
          "messages" in preResult.payload
            ? preResult.payload.messages
            : chatBody.messages;

        const outBody: OpenAIChatBody = {
          ...chatBody,
          messages: evaluatedMessages.map((m) => ({
            role: m.role,
            content: m.content ?? null,
          })),
        };

        // ------------------------------------------------------------------
        // 3. Forward to upstream
        // ------------------------------------------------------------------
        const reqHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (v !== undefined) {
            reqHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
          }
        }

        const upstreamResp = await tracer.startActiveSpan(
          "tg.upstream.call",
          { kind: SpanKind.CLIENT },
          async (upSpan) => {
            upSpan.setAttributes({
              "http.url": upstream,
              "http.method": "POST",
              "http.route": ctx.path,
            });
            try {
              const resp = await callUpstream({
                upstreamBase: upstream,
                path: ctx.path,
                method: "POST",
                apiKey: ctx.upstreamApiKey,
                body: JSON.stringify(outBody),
                headers: reqHeaders,
                stream: Boolean(chatBody.stream),
              });
              upSpan.setAttributes({ "http.status_code": resp.status });
              if (!resp.ok) upSpan.setStatus({ code: SpanStatusCode.ERROR });
              return resp;
            } finally {
              upSpan.end();
            }
          },
        );

        if (!upstreamResp.ok) {
          // Pass through upstream error faithfully
          res.writeHead(upstreamResp.status, {
            "Content-Type": "application/json",
            "X-TransparentGuard-Request-ID": ctx.requestId,
          });
          res.end(upstreamResp.body);
          rootSpan.setAttributes({ "http.status_code": upstreamResp.status });
          rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: "upstream error" });
          rootSpan.end();
          return;
        }

        // ------------------------------------------------------------------
        // 4. Post-response evaluation
        // ------------------------------------------------------------------
        let assembledContent: string;
        let parsedChunks = parseSseLines([]);

        if (chatBody.stream) {
          parsedChunks = parseSseLines(upstreamResp.rawChunks);
          assembledContent = assembleContent(parsedChunks);
        } else {
          let completion: OpenAIChatCompletion;
          try {
            completion = JSON.parse(upstreamResp.body) as OpenAIChatCompletion;
          } catch {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Upstream returned invalid JSON", type: "upstream_error", code: "bad_gateway" } }));
            rootSpan.end();
            return;
          }
          assembledContent = completion.choices[0]?.message?.content ?? "";
        }

        const responsePayload = {
          content: assembledContent,
          provider: "openai",
          model: chatBody.model,
        };

        const postResult = await tracer.startActiveSpan(
          "tg.evaluate.post_response",
          async (postSpan) => {
            try {
              const result = await tg.evaluate("post-response", responsePayload, {
                requestId: ctx.requestId,
              });
              postSpan.setAttributes({
                "tg.outcome": result.allowed ? "allowed" : "blocked",
                "tg.violations": result.violations.length,
              });
              return result;
            } finally {
              postSpan.end();
            }
          },
        );

        rootSpan.setAttributes({
          "tg.post_response.outcome": postResult.allowed ? "allowed" : "blocked",
        });

        // ------------------------------------------------------------------
        // 5. Return response (possibly blocked or redacted)
        // ------------------------------------------------------------------
        if (chatBody.stream) {
          if (!postResult.allowed) {
            const blockMsg =
              postResult.violations[0]?.detail ??
              "Response blocked by TransparentGuard policy.";
            sendSseBlock(res, blockMsg, ctx.requestId);
          } else {
            const redactedContent =
              "content" in postResult.payload
                ? (postResult.payload as { content: string }).content
                : assembledContent;

            startSseResponse(res, { "X-TransparentGuard-Request-ID": ctx.requestId });
            if (redactedContent !== assembledContent) {
              emitRedactedSseChunks(res, parsedChunks, redactedContent);
            } else {
              emitSseChunks(res, parsedChunks);
            }
            res.end();
          }
        } else {
          if (!postResult.allowed) {
            const blockMsg =
              postResult.violations[0]?.detail ??
              "Response blocked by TransparentGuard policy.";
            sendOpenAIError(res, 400, blockMsg, "policy_violation", "policy_violation");
          } else {
            // Re-emit the upstream response (possibly with redacted content injected)
            res.writeHead(200, {
              "Content-Type": "application/json",
              "X-TransparentGuard-Request-ID": ctx.requestId,
            });
            res.end(upstreamResp.body);
          }
        }

        rootSpan.setAttributes({ "http.status_code": 200 });
        rootSpan.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        console.error(`[TransparentGuard] Handler error for ${ctx.requestId}: ${String(err)}`);
        rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        if (!res.headersSent) {
          sendOpenAIError(res, 500, "Internal proxy error.", "internal_error", "internal_error");
        }
      } finally {
        rootSpan.end();
      }
    },
  );
}
