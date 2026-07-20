/**
 * TransparentGuard Runtime — Dataset Validator
 *
 * Statistical validation of labeled datasets before training.
 * All checks are configurable. Failures are non-throwing — returns a report.
 *
 * Checks:
 *   - Minimum example count (default: 20 per label)
 *   - Label balance (balance_score ≥ 0.3)
 *   - Duplicate detection
 *   - Minimum vocabulary diversity
 *   - Soft-label confidence distribution
 */

import type { LabeledExample, DatasetStats } from "../types.js";

// ---------------------------------------------------------------------------
// Validation result types
// ---------------------------------------------------------------------------

export type ValidationSeverity = "error" | "warning" | "info";

export interface ValidationFinding {
  severity: ValidationSeverity;
  code: string;
  message: string;
  detail?: string;
}

export interface ValidationReport {
  classifier_name: string;
  validated_at: string;
  example_count: number;
  passed: boolean;
  findings: ValidationFinding[];
  stats: DatasetStats;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export interface ValidationConfig {
  /** Minimum examples per label. Default: 20. */
  min_examples_per_label?: number;
  /** Minimum overall examples. Default: 40. */
  min_total_examples?: number;
  /** Minimum balance score [0,1]. Default: 0.3. */
  min_balance_score?: number;
  /** Maximum duplicate fraction [0,1]. Default: 0.1 (10%). */
  max_duplicate_fraction?: number;
  /** Minimum vocabulary size. Default: 50. */
  min_vocab_size?: number;
  /** Maximum fraction of uncertain examples [0,1]. Default: 0.4. */
  max_uncertain_fraction?: number;
}

const DEFAULTS: Required<ValidationConfig> = {
  min_examples_per_label: 20,
  min_total_examples: 40,
  min_balance_score: 0.3,
  max_duplicate_fraction: 0.1,
  min_vocab_size: 50,
  max_uncertain_fraction: 0.4,
};

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

import { computeStats } from "./store.js";

/**
 * Validate a set of labeled examples.
 * Returns a detailed report with per-check findings.
 * `passed` is true only when no `error`-severity findings exist.
 */
export function validateDataset(
  classifierName: string,
  examples: LabeledExample[],
  config: ValidationConfig = {},
): ValidationReport {
  const cfg = { ...DEFAULTS, ...config };
  const findings: ValidationFinding[] = [];
  const stats = computeStats(examples);

  // --- Total count ---
  if (examples.length < cfg.min_total_examples) {
    findings.push({
      severity: "error",
      code: "INSUFFICIENT_EXAMPLES",
      message: `Dataset has ${examples.length} examples but requires at least ${cfg.min_total_examples}.`,
      detail: "Add more labeled examples before training.",
    });
  } else if (examples.length < cfg.min_total_examples * 2) {
    findings.push({
      severity: "warning",
      code: "LOW_EXAMPLE_COUNT",
      message: `Dataset has ${examples.length} examples. More examples generally improve model quality.`,
    });
  }

  // --- Per-label count ---
  for (const [label, count] of Object.entries(stats.label_distribution)) {
    if (count < cfg.min_examples_per_label) {
      findings.push({
        severity: "error",
        code: "INSUFFICIENT_LABEL_EXAMPLES",
        message: `Label "${label}" has only ${count} examples. Minimum is ${cfg.min_examples_per_label}.`,
        detail: "Add more labeled examples for this class.",
      });
    }
  }

  // --- Label balance ---
  if (stats.balance_score < cfg.min_balance_score) {
    findings.push({
      severity: "warning",
      code: "CLASS_IMBALANCE",
      message: `Balance score is ${stats.balance_score.toFixed(2)} (minimum recommended: ${cfg.min_balance_score}).`,
      detail: "Consider adding more examples for under-represented labels, or use class-weighted training.",
    });
  }

  // --- Duplicates ---
  const dupFraction = stats.total > 0 ? stats.duplicate_count / stats.total : 0;
  if (dupFraction > cfg.max_duplicate_fraction) {
    findings.push({
      severity: "warning",
      code: "HIGH_DUPLICATE_FRACTION",
      message: `${stats.duplicate_count} duplicate text IDs detected (${(dupFraction * 100).toFixed(1)}% of dataset).`,
      detail: "Run `tg dataset validate` with --dedupe to clean.",
    });
  } else if (stats.duplicate_count > 0) {
    findings.push({
      severity: "info",
      code: "DUPLICATES_PRESENT",
      message: `${stats.duplicate_count} duplicate text IDs detected.`,
    });
  }

  // --- Vocabulary diversity ---
  if (stats.vocab_size < cfg.min_vocab_size) {
    findings.push({
      severity: "warning",
      code: "LOW_VOCABULARY",
      message: `Vocabulary size is ${stats.vocab_size} unique tokens. Minimum recommended: ${cfg.min_vocab_size}.`,
      detail: "Low vocabulary may indicate overly similar examples. Add more diverse text.",
    });
  }

  // --- Uncertain examples ---
  const uncertainFraction = stats.total > 0 ? stats.uncertain_count / stats.total : 0;
  if (uncertainFraction > cfg.max_uncertain_fraction) {
    findings.push({
      severity: "warning",
      code: "HIGH_UNCERTAINTY",
      message: `${stats.uncertain_count} examples (${(uncertainFraction * 100).toFixed(1)}%) have confidence in [0.35, 0.65].`,
      detail: "High uncertainty rate suggests the dataset may benefit from human review. Run `tg dataset review`.",
    });
  }

  // --- Labels present ---
  const labelCount = Object.keys(stats.label_distribution).length;
  if (labelCount < 2) {
    findings.push({
      severity: "error",
      code: "SINGLE_LABEL",
      message: "Dataset has only one label class. A classifier needs at least two classes.",
    });
  } else {
    findings.push({
      severity: "info",
      code: "LABELS_OK",
      message: `${labelCount} label classes found: ${Object.keys(stats.label_distribution).join(", ")}.`,
    });
  }

  const passed = !findings.some((f) => f.severity === "error");

  return {
    classifier_name: classifierName,
    validated_at: new Date().toISOString(),
    example_count: examples.length,
    passed,
    findings,
    stats,
  };
}

/**
 * Format a validation report for terminal output.
 */
export function formatValidationReport(report: ValidationReport): string {
  const lines: string[] = [];
  const icon = report.passed ? "✓" : "✗";
  lines.push(`\n${icon} Dataset validation — ${report.classifier_name}`);
  lines.push(`  Examples : ${report.example_count}`);
  lines.push(`  Labels   : ${Object.keys(report.stats.label_distribution).join(", ")}`);
  lines.push(`  Balance  : ${report.stats.balance_score.toFixed(2)}`);
  lines.push(`  Vocab    : ${report.stats.vocab_size} tokens`);
  lines.push(`  Status   : ${report.passed ? "PASS" : "FAIL"}\n`);

  for (const f of report.findings) {
    const prefix = f.severity === "error" ? "  ERROR" : f.severity === "warning" ? "  WARN " : "  INFO ";
    lines.push(`${prefix}  ${f.message}`);
    if (f.detail) lines.push(`         ${f.detail}`);
  }

  lines.push("");
  return lines.join("\n");
}
