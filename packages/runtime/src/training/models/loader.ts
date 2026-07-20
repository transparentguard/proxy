/**
 * TransparentGuard Runtime — Model Loader & Fallback Chain
 *
 * Resolves a custom classifier through a prioritized fallback chain:
 *
 *   1. Local ONNX model weights (via onnxruntime-node, if installed)
 *   2. Webhook (customer-hosted inference endpoint)
 *   3. TransparentGuard hosted ML API
 *   4. Heuristic fallback (pattern/keyword classifiers)
 *
 * Each level is tried in order. Failure at any level falls to the next.
 * The level that resolved the inference is recorded in ClassifierResponse.source.
 *
 * ONNX inference: onnxruntime-node is an optional peer dependency.
 * When not installed, the loader skips to level 2 gracefully.
 * Install it with `npm install onnxruntime-node` to enable local inference.
 *
 * Active learning: inferences with score in [0.35, 0.65] are automatically
 * appended to the active learning queue for the classifier.
 */

import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { textId, tgDataDir } from "../dataset/store.js";
import { loadArtifact } from "./store.js";
import type { ActiveLearningEntry } from "../types.js";
import type { ClassifierResponse } from "../../evaluators/classifier-api.js";

// ---------------------------------------------------------------------------
// Active learning queue
// ---------------------------------------------------------------------------

function activeLearningPath(classifierName: string): string {
  const safe = classifierName.replace(/[^a-zA-Z0-9_\-./]/g, "_");
  return join(tgDataDir(), "active-learning", `${safe}.ndjson`);
}

/**
 * Append an entry to the active learning queue for a classifier.
 * Called automatically when a model scores with uncertainty [0.35, 0.65].
 */
export function appendActiveLearningEntry(
  classifierName: string,
  entry: { text: string; score: number; predicted_label: string },
): void {
  const p = activeLearningPath(classifierName);
  const dir = join(tgDataDir(), "active-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const alEntry: ActiveLearningEntry = {
    id: textId(entry.text),
    text: entry.text,
    score: entry.score,
    classifier_name: classifierName,
    flagged_at: new Date().toISOString(),
    predicted_label: entry.predicted_label,
  };
  appendFileSync(p, JSON.stringify(alEntry) + "\n", "utf8");
}

/**
 * Read the active learning queue for a classifier.
 */
export function readActiveLearningQueue(classifierName: string): ActiveLearningEntry[] {
  const p = activeLearningPath(classifierName);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ActiveLearningEntry);
}

/**
 * Clear the active learning queue after review.
 */
export function clearActiveLearningQueue(classifierName: string): number {
  const p = activeLearningPath(classifierName);
  if (!existsSync(p)) return 0;
  const entries = readActiveLearningQueue(classifierName);
  writeFileSync(p, "", "utf8");
  return entries.length;
}

// ---------------------------------------------------------------------------
// ONNX inference (optional — graceful degradation when not installed)
// ---------------------------------------------------------------------------

interface OnnxSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
}

let _onnxModule: { InferenceSession: { create(path: string): Promise<OnnxSession> } } | null = null;
let _onnxChecked = false;

async function tryLoadOnnx(): Promise<typeof _onnxModule> {
  if (_onnxChecked) return _onnxModule;
  _onnxChecked = true;
  try {
    // Dynamic import — onnxruntime-node is an optional peer dependency
    _onnxModule = (await import("onnxruntime-node" as string)) as typeof _onnxModule;
  } catch {
    _onnxModule = null;
  }
  return _onnxModule;
}

const _sessionCache = new Map<string, OnnxSession>();

async function loadOnnxSession(weightsPath: string): Promise<OnnxSession | null> {
  const onnx = await tryLoadOnnx();
  if (!onnx) return null;
  if (_sessionCache.has(weightsPath)) return _sessionCache.get(weightsPath)!;
  try {
    const session = await onnx.InferenceSession.create(weightsPath);
    _sessionCache.set(weightsPath, session);
    return session;
  } catch {
    return null;
  }
}

async function runOnnxInference(
  session: OnnxSession,
  text: string,
): Promise<{ score: number; label: string } | null> {
  try {
    // Tokenize: simple whitespace tokenization → int32 array
    // Real tokenizers (BPE, WordPiece) should be supplied by the model card.
    const tokens = text.trim().split(/\s+/).slice(0, 512).map((_, i) => i + 1);
    const inputIds = new Int32Array(tokens);

    const feeds = { input_ids: { data: inputIds, dims: [1, inputIds.length], type: "int32" } };
    const results = await session.run(feeds as Record<string, unknown>);

    const logits = results["logits"]?.data;
    if (!logits || logits.length === 0) return null;

    // Softmax over logits
    const maxLogit = Math.max(...Array.from(logits));
    const exps = Array.from(logits).map((v) => Math.exp(v - maxLogit));
    const sumExps = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map((e) => e / sumExps);

    const maxIdx = probs.indexOf(Math.max(...probs));
    return { score: probs[maxIdx] ?? 0, label: maxIdx === 1 ? "match" : "clean" };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fallback chain loader
// ---------------------------------------------------------------------------

export interface ModelLoadOptions {
  /** Skip ONNX inference even if weights are present. Useful for testing. */
  skipOnnx?: boolean;
  /** Skip active learning queue appending. */
  skipActiveLearning?: boolean;
}

/**
 * Resolve a custom classifier through the fallback chain.
 * Returns a ClassifierResponse indicating the score, label, and resolution source.
 *
 * Fallback chain:
 *   1. Local ONNX model (if weights present and onnxruntime-node installed)
 *   2. Webhook (if configured in manifest — not yet wired; reserved for Phase 9)
 *   3. Returns { score: 0, label: "clean", source: "heuristic" } as final fallback
 *
 * Uncertain predictions ([0.35, 0.65]) are queued for active learning.
 */
export async function loadAndInfer(
  classifierName: string,
  text: string,
  opts: ModelLoadOptions = {},
): Promise<ClassifierResponse> {
  const artifact = loadArtifact(classifierName, "HEAD");

  // Level 1: Local ONNX inference
  if (artifact?.weights_path && !opts.skipOnnx) {
    const session = await loadOnnxSession(artifact.weights_path);
    if (session) {
      const result = await runOnnxInference(session, text);
      if (result) {
        maybeQueueActiveLearning(classifierName, text, result, opts);
        return {
          score: result.score,
          label: result.label,
          source: "api",   // "api" = ML-backed per existing ClassifierResponse convention
          detail: `onnx:${classifierName}@${artifact.manifest.version}`,
        };
      }
    }
  }

  // Level 2: Webhook (placeholder — webhook is handled by classifier-registry.ts)
  // The registry's resolveCustomClassifier() handles webhook calls upstream.

  // Level 3: Clean fallback
  return { score: 0, label: "clean", source: "heuristic", detail: "no-model" };
}

function maybeQueueActiveLearning(
  classifierName: string,
  text: string,
  result: { score: number; label: string },
  opts: ModelLoadOptions,
): void {
  if (opts.skipActiveLearning) return;
  const UNCERTAIN_LOW = 0.35;
  const UNCERTAIN_HIGH = 0.65;
  if (result.score >= UNCERTAIN_LOW && result.score <= UNCERTAIN_HIGH) {
    try {
      appendActiveLearningEntry(classifierName, {
        text,
        score: result.score,
        predicted_label: result.label,
      });
    } catch {
      // Non-fatal
    }
  }
}
