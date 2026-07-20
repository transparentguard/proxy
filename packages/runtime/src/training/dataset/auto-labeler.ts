/**
 * TransparentGuard Runtime — Auto-Labeler
 *
 * Bootstraps a training dataset by running existing TG classifiers
 * against unlabeled text, writing results as "auto"-sourced examples.
 *
 * Auto-labeled examples with confidence < 0.8 are flagged for the
 * active learning queue and marked for human review.
 *
 * No external service calls — uses the in-process heuristic classifiers only.
 * When the hosted ML API is available, pass an apiKey to use it instead.
 */

import { existsSync, readFileSync } from "fs";
import { addExample } from "./store.js";
import { appendActiveLearningEntry } from "../models/loader.js";
import type { LabeledExample } from "../types.js";

// ---------------------------------------------------------------------------
// Heuristic classifier bridge
// ---------------------------------------------------------------------------

// Inline the classifier invocation to avoid circular deps with the engine
type SimpleClassifyFn = (text: string) => Promise<{ score: number; label: string }>;

/**
 * A registry of simple classifiers available for auto-labeling.
 * Add entries here to make them available as bootstrap sources.
 */
const BUILTIN_AUTO_LABELERS: Record<string, SimpleClassifyFn> = {};

/** Register a function as an auto-labeler for a given classifier name. */
export function registerAutoLabeler(classifierName: string, fn: SimpleClassifyFn): void {
  BUILTIN_AUTO_LABELERS[classifierName] = fn;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface AutoLabelResult {
  classifier_name: string;
  total_input: number;
  labeled: number;
  queued_for_review: number;
  skipped: number;
  high_confidence_threshold: number;
  examples: LabeledExample[];
}

// ---------------------------------------------------------------------------
// Core auto-labeler
// ---------------------------------------------------------------------------

/**
 * Auto-label unlabeled text using an existing classifier.
 *
 * @param classifierName - Target classifier to label for AND to use as the labeling source.
 * @param texts - Array of raw text strings to label.
 * @param highConfidenceThreshold - Confidence above which labels are written directly.
 *   Examples below this are added to the active learning queue. Default: 0.8.
 *
 * Labels above threshold → written to dataset as source="auto"
 * Labels below threshold → written to active learning queue, NOT to dataset
 */
export async function autoLabel(
  classifierName: string,
  texts: string[],
  highConfidenceThreshold = 0.8,
): Promise<AutoLabelResult> {
  const fn = BUILTIN_AUTO_LABELERS[classifierName];
  if (!fn) {
    throw new Error(
      `No auto-labeler registered for classifier "${classifierName}". ` +
      "Register one with registerAutoLabeler() or use a webhook-backed classifier.",
    );
  }

  let labeled = 0;
  let queuedForReview = 0;
  let skipped = 0;
  const examples: LabeledExample[] = [];

  for (const text of texts) {
    if (!text || !text.trim()) { skipped++; continue; }

    let result: { score: number; label: string };
    try {
      result = await fn(text);
    } catch {
      skipped++;
      continue;
    }

    if (result.score >= highConfidenceThreshold) {
      const ex = addExample(classifierName, text, {
        label: result.label,
        confidence: result.score,
        source: "auto",
        annotator: `tg-auto:${classifierName}`,
        metadata: { auto_labeled: true },
      });
      if (ex) {
        examples.push(ex);
        labeled++;
      } else {
        skipped++;
      }
    } else {
      // Below threshold — queue for human review
      try {
        appendActiveLearningEntry(classifierName, {
          text,
          score: result.score,
          predicted_label: result.label,
        });
      } catch {
        // Active learning queue write failure is non-fatal
      }
      queuedForReview++;
    }
  }

  return {
    classifier_name: classifierName,
    total_input: texts.length,
    labeled,
    queued_for_review: queuedForReview,
    skipped,
    high_confidence_threshold: highConfidenceThreshold,
    examples,
  };
}

/**
 * Auto-label from a JSONL file of unlabeled text.
 * Each line must be a JSON object with a `text` field.
 */
export async function autoLabelFromFile(
  classifierName: string,
  filePath: string,
  highConfidenceThreshold = 0.8,
): Promise<AutoLabelResult> {
  if (!existsSync(filePath)) {
    throw new Error(`Unlabeled text file not found: ${filePath}`);
  }

  const texts = readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        return typeof obj["text"] === "string" ? obj["text"] : line;
      } catch {
        return line;
      }
    });

  return autoLabel(classifierName, texts, highConfidenceThreshold);
}

