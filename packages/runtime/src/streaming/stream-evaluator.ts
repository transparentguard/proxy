/**
 * TransparentGuard Runtime — Streaming Enforcement Engine
 *
 * Implements all three TPS streaming modes (Section 25):
 *   buffer      — collect all tokens, evaluate full response, re-yield (default, lowest risk)
 *   window      — evaluate rolling windows of N tokens; abort mid-stream on violation
 *   passthrough — yield every token immediately; full evaluation at completion
 *
 * Generic over chunk type C via StreamChunkAdapter<C>.
 * Used by provider wrappers; not called directly by engine.ts.
 */

import type {
  ResponsePayload,
  TPSPolicy,
  EvaluateOptions,
  StreamMode,
  OnStreamViolation,
} from "../types.js";
import { assertFeature, TransparentGuardError } from "../license/checker.js";
import type { LicenseStatus } from "../license/checker.js";
import { evaluate } from "../engine.js";
import type { AuditEmitter } from "../audit/emitter.js";
import { approximateTokenCount } from "../enforcements/token-budget.js";

// Re-export so callers can import StreamMode/OnStreamViolation from here too
export type { StreamMode, OnStreamViolation } from "../types.js";

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

export interface StreamEvalConfig {
  mode: StreamMode;
  /** How many tokens to accumulate before evaluating a window (window mode only) */
  windowTokens: number;
  /** What to do when a violation is found mid-stream */
  onStreamViolation: OnStreamViolation;
}

/** Derive the effective streaming configuration from policy defaults + per-call overrides */
export function resolveStreamConfig(
  policy: TPSPolicy,
  overrides?: EvaluateOptions,
): StreamEvalConfig {
  return {
    mode: overrides?.streamMode ?? policy.audit.streaming?.mode ?? "buffer",
    windowTokens:
      overrides?.windowTokens ?? policy.audit.streaming?.window_tokens ?? 200,
    onStreamViolation:
      overrides?.onStreamViolation ??
      policy.audit.streaming?.on_stream_violation ??
      "block",
  };
}

// ---------------------------------------------------------------------------
// Provider-agnostic chunk adapter
// ---------------------------------------------------------------------------

/**
 * Adapter callbacks that bridge provider-specific chunk types to the generic evaluator.
 * Implemented once per provider wrapper (OpenAI, Anthropic, etc.).
 */
export interface StreamChunkAdapter<C> {
  /** Extract text content from a chunk. Returns null/undefined when the chunk carries no text. */
  getContent(chunk: C): string | null | undefined;
  /** Extract model identifier from a chunk, if present. */
  getModel(chunk: C): string | undefined;
  /** Returns true when this chunk signals stream completion (finish_reason set, message_stop, etc.) */
  isFinish(chunk: C): boolean;
  /** Build a TPS ResponsePayload from the accumulated content + resolved model name. */
  makePayload(content: string, model: string): ResponsePayload;
  /**
   * Produce a synthetic "abort" chunk appended after a passthrough violation.
   * Signals to the consumer that content must be discarded.
   */
  makeAbortChunk(violationDetail: string, templateChunk: C): C;
  /**
   * Produce a synthetic chunk containing redacted window content.
   * Replaces the original window chunks when window-mode redaction fires.
   */
  makeRedactedChunk(redactedContent: string, templateChunk: C): C;
}

// ---------------------------------------------------------------------------
// Window mode
// ---------------------------------------------------------------------------

/**
 * Window-mode streaming evaluator.
 *
 * Accumulates chunks into windows of `config.windowTokens` tokens.
 * After each full window (and at stream end) evaluates the full accumulated
 * response so far via the post-response rule graph.
 *
 * On violation with onStreamViolation = "block":
 *   Throws TransparentGuardError — the caller's for-await loop will terminate.
 *
 * On violation with onStreamViolation = "passthrough_and_log":
 *   Logs the violation via the audit emitter and continues yielding.
 *
 * On redaction (final window only):
 *   Yields a single synthetic redacted chunk in place of the raw window chunks.
 */
export async function* evaluateWindowedStream<C>(
  source: AsyncIterable<C>,
  adapter: StreamChunkAdapter<C>,
  policy: TPSPolicy,
  license: LicenseStatus,
  evalOptions: EvaluateOptions,
  config: StreamEvalConfig,
  emitter: AuditEmitter,
): AsyncGenerator<C> {
  // Gate 2: window mode is a Startup+ feature; buffer mode is always available
  assertFeature(license, "streaming_window", "Streaming window mode");
  let accumulated = "";
  let windowTokenCount = 0;
  let windowChunks: C[] = [];
  let firstChunk: C | undefined;
  let model = "";

  const flushWindow = async (isFinal: boolean): Promise<C[]> => {
    if (windowChunks.length === 0) return [];

    const payload = adapter.makePayload(accumulated, model);
    const result = await evaluate("post-response", payload, policy, license, evalOptions);
    emitter.enqueueMany(result.audit_events);

    if (!result.allowed) {
      const detail =
        result.violations[0]?.detail ??
        "Policy violation detected in stream window";

      if (config.onStreamViolation === "block") {
        throw new TransparentGuardError(detail, "policy_violation");
      }
      // passthrough_and_log: yield original window chunks unchanged
      return windowChunks;
    }

    const finalPayload = result.payload as ResponsePayload;
    const contentWasRedacted = isFinal ? finalPayload.content !== accumulated : false;

    if (contentWasRedacted && firstChunk) {
      return [adapter.makeRedactedChunk(finalPayload.content, firstChunk)];
    }

    return windowChunks;
  };

  for await (const chunk of source) {
    if (!firstChunk) firstChunk = chunk;

    const chunkModel = adapter.getModel(chunk);
    if (chunkModel) model = chunkModel;

    const content = adapter.getContent(chunk);
    if (content) {
      accumulated += content;
      windowTokenCount += approximateTokenCount(content);
    }
    windowChunks.push(chunk);

    const isFinalChunk = adapter.isFinish(chunk);

    if (windowTokenCount >= config.windowTokens || isFinalChunk) {
      const toYield = await flushWindow(isFinalChunk);
      for (const c of toYield) yield c;
      windowTokenCount = 0;
      windowChunks = [];
    }
  }

  // Flush any remaining unflushed chunks
  if (windowChunks.length > 0) {
    const toYield = await flushWindow(true);
    for (const c of toYield) yield c;
  }
}

// ---------------------------------------------------------------------------
// Passthrough mode
// ---------------------------------------------------------------------------

/**
 * Passthrough-mode streaming evaluator.
 *
 * Yields every chunk to the consumer immediately as it arrives.
 * Simultaneously accumulates all content. After the stream ends,
 * runs a full post-response evaluation on the complete content.
 *
 * On violation with onStreamViolation = "block":
 *   Appends a synthetic abort chunk to signal the consumer, then throws.
 *
 * On violation with onStreamViolation = "passthrough_and_log":
 *   Logs the violation via the audit emitter. Consumer already has all tokens.
 *
 * Note: passthrough mode cannot redact content already sent to the consumer.
 * For redaction guarantees use buffer or window mode.
 */
export async function* evaluatePassthroughStream<C>(
  source: AsyncIterable<C>,
  adapter: StreamChunkAdapter<C>,
  policy: TPSPolicy,
  license: LicenseStatus,
  evalOptions: EvaluateOptions,
  config: StreamEvalConfig,
  emitter: AuditEmitter,
): AsyncGenerator<C> {
  // Gate 2: passthrough mode shares the streaming_window feature gate (Startup tier and above)
  assertFeature(license, "streaming_window", "Streaming passthrough mode");
  let accumulated = "";
  let model = "";
  let firstChunk: C | undefined;

  for await (const chunk of source) {
    if (!firstChunk) firstChunk = chunk;
    const chunkModel = adapter.getModel(chunk);
    if (chunkModel) model = chunkModel;
    const content = adapter.getContent(chunk);
    if (content) accumulated += content;
    yield chunk; // passthrough — emit immediately
  }

  if (!accumulated || !firstChunk) return;

  // Post-stream evaluation on fully assembled content
  const payload = adapter.makePayload(accumulated, model);
  const result = await evaluate("post-response", payload, policy, license, evalOptions);
  emitter.enqueueMany(result.audit_events);

  if (!result.allowed) {
    const detail =
      result.violations[0]?.detail ??
      "Policy violation detected after stream completion";

    if (config.onStreamViolation === "block") {
      yield adapter.makeAbortChunk(detail, firstChunk);
      throw new TransparentGuardError(detail, "policy_violation");
    }
    // passthrough_and_log: already yielded all tokens; violation is in audit log
  }
}
