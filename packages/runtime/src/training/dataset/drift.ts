/**
 * TransparentGuard Runtime — Distribution Drift Detector
 *
 * Compares the live inference score distribution against the training
 * distribution using KL divergence. When divergence exceeds a threshold,
 * a retraining recommendation is emitted.
 *
 * Rolling window entries are stored in the model artifact directory as
 * drift-window.ndjson. The window is capped at MAX_WINDOW_ENTRIES.
 *
 * KL divergence formula: sum(p_i * log(p_i / q_i)) over non-zero p_i.
 * Distributions are over discretized score buckets [0.0, 0.1, ..., 1.0].
 */

import { existsSync, appendFileSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { textId } from "./store.js";
import type { DriftReport, DriftWindowEntry } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of entries in the rolling drift window. */
const MAX_WINDOW_ENTRIES = 10_000;

/** Default KL divergence threshold for declaring drift. */
const DEFAULT_DRIFT_THRESHOLD = 0.1;

/** Number of score buckets for discretization. */
const NUM_BUCKETS = 10;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function driftWindowPath(artifactDir: string): string {
  return join(artifactDir, "drift-window.ndjson");
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

/**
 * Append an inference result to the rolling drift window.
 * Automatically trims the window to MAX_WINDOW_ENTRIES.
 */
export function appendDriftEntry(
  artifactDir: string,
  entry: Omit<DriftWindowEntry, "ts">,
): void {
  const e: DriftWindowEntry = {
    ts: new Date().toISOString(),
    score: entry.score,
    label: entry.label,
    text_id: entry.text_id,
  };
  appendFileSync(driftWindowPath(artifactDir), JSON.stringify(e) + "\n", "utf8");
  trimDriftWindow(artifactDir);
}

function trimDriftWindow(artifactDir: string): void {
  const p = driftWindowPath(artifactDir);
  if (!existsSync(p)) return;
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  if (lines.length > MAX_WINDOW_ENTRIES) {
    const trimmed = lines.slice(lines.length - MAX_WINDOW_ENTRIES);
    writeFileSync(p, trimmed.join("\n") + "\n", "utf8");
  }
}

/** Read all entries from the rolling drift window. */
export function readDriftWindow(artifactDir: string): DriftWindowEntry[] {
  const p = driftWindowPath(artifactDir);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DriftWindowEntry);
}

// ---------------------------------------------------------------------------
// Distribution computation
// ---------------------------------------------------------------------------

/** Discretize a set of scores into NUM_BUCKETS buckets, normalized to a probability distribution. */
function scoresToDistribution(scores: number[]): number[] {
  const buckets = new Array<number>(NUM_BUCKETS).fill(0);
  for (const s of scores) {
    const idx = Math.min(Math.floor(s * NUM_BUCKETS), NUM_BUCKETS - 1);
    buckets[idx]++;
  }
  const total = buckets.reduce((a, b) => a + b, 0);
  return total > 0 ? buckets.map((b) => b / total) : buckets.map(() => 1 / NUM_BUCKETS);
}

/**
 * Compute KL divergence D_KL(P || Q).
 * P = training distribution, Q = current distribution.
 * Uses a small epsilon for numerical stability on zero entries.
 */
function klDivergence(p: number[], q: number[]): number {
  const eps = 1e-10;
  let kl = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] > 0) {
      kl += p[i] * Math.log((p[i] + eps) / ((q[i] ?? 0) + eps));
    }
  }
  return kl;
}

// ---------------------------------------------------------------------------
// Drift check
// ---------------------------------------------------------------------------

/**
 * Check for distribution drift by comparing the live inference window
 * against the training score distribution.
 *
 * @param classifierName - Name of the classifier being monitored.
 * @param artifactDir - Path to the model artifact directory.
 * @param trainingScores - The score values from the training dataset.
 * @param threshold - KL divergence threshold. Default: 0.1.
 */
export function checkDrift(
  classifierName: string,
  artifactDir: string,
  trainingScores: number[],
  threshold = DEFAULT_DRIFT_THRESHOLD,
): DriftReport {
  const windowEntries = readDriftWindow(artifactDir);
  const now = new Date().toISOString();

  if (windowEntries.length < 50) {
    // Not enough data to check drift meaningfully
    return {
      classifier_name: classifierName,
      checked_at: now,
      divergence: 0,
      threshold,
      is_drifted: false,
      training_distribution: buildLabelDist(trainingScores),
      current_distribution: {},
      recommendation: "Insufficient inference data for drift check (need ≥ 50 entries).",
    };
  }

  const trainDist = scoresToDistribution(trainingScores);
  const liveDist = scoresToDistribution(windowEntries.map((e) => e.score));
  const divergence = klDivergence(trainDist, liveDist);
  const isDrifted = divergence > threshold;

  // Build label distributions for the report
  const trainingLabelDist = buildLabelDist(trainingScores);
  const liveLabelDist = buildWindowLabelDist(windowEntries);

  let recommendation: string | undefined;
  if (isDrifted) {
    recommendation =
      `KL divergence ${divergence.toFixed(4)} exceeds threshold ${threshold}. ` +
      `Retraining recommended. Run \`tg train start ${classifierName}\`.`;
  } else {
    recommendation = `Distribution stable (KL = ${divergence.toFixed(4)}).`;
  }

  return {
    classifier_name: classifierName,
    checked_at: now,
    divergence,
    threshold,
    is_drifted: isDrifted,
    training_distribution: trainingLabelDist,
    current_distribution: liveLabelDist,
    recommendation,
  };
}

function buildLabelDist(scores: number[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const s of scores) {
    const bucket = `score_${(Math.floor(s * 10) / 10).toFixed(1)}`;
    dist[bucket] = (dist[bucket] ?? 0) + 1;
  }
  return dist;
}

function buildWindowLabelDist(entries: DriftWindowEntry[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const e of entries) {
    dist[e.label] = (dist[e.label] ?? 0) + 1;
  }
  return dist;
}
