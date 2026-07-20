/**
 * TransparentGuard Runtime — Dataset Store
 *
 * Content-addressed JSONL storage for labeled training examples.
 * Each dataset lives under: ~/.tg/datasets/<classifier-name>/
 *
 * Storage format is Arrow-schema-compatible JSONL:
 *   - Same field names and types as the LabeledExample Arrow schema
 *   - Directly loadable by pyarrow.read_json() or DuckDB read_json_auto()
 *   - Exportable to Parquet via `tg dataset export --format parquet` (requires external tool)
 *
 * Integrity: every example's `id` is the SHA-256 of its `text`.
 * Mutation is append-only. Deduplication is enforced at write time.
 */

import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import type {
  LabeledExample,
  DatasetManifest,
  DatasetStats,
  DataSource,
} from "../types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function tgDataDir(): string {
  return process.env["TG_DATA_DIR"] ?? join(homedir(), ".tg");
}

export function datasetDir(classifierName: string): string {
  const safe = classifierName.replace(/[^a-zA-Z0-9_\-./]/g, "_");
  return join(tgDataDir(), "datasets", safe);
}

function headDataPath(classifierName: string): string {
  return join(datasetDir(classifierName), "head.jsonl");
}

function manifestPath(classifierName: string): string {
  return join(datasetDir(classifierName), "manifest.json");
}

// ---------------------------------------------------------------------------
// Content addressing
// ---------------------------------------------------------------------------

/** Stable SHA-256 hex of a text string. Used as LabeledExample.id. */
export function textId(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA-256 hex of file contents. Used for dataset version hashes. */
export function fileHash(filePath: string): string {
  if (!existsSync(filePath)) return "empty";
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

function ensureDatasetDir(classifierName: string): void {
  const dir = datasetDir(classifierName);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadManifest(classifierName: string): DatasetManifest {
  const p = manifestPath(classifierName);
  if (!existsSync(p)) {
    const now = new Date().toISOString();
    return {
      classifier_name: classifierName,
      created_at: now,
      updated_at: now,
      head: "v0",
      versions: [],
    };
  }
  return JSON.parse(readFileSync(p, "utf8")) as DatasetManifest;
}

function saveManifest(classifierName: string, manifest: DatasetManifest): void {
  writeFileSync(manifestPath(classifierName), JSON.stringify(manifest, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Reading examples
// ---------------------------------------------------------------------------

/** Read all examples from the HEAD dataset file. */
export function readExamples(classifierName: string): LabeledExample[] {
  const p = headDataPath(classifierName);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LabeledExample);
}

/** Read examples from a specific versioned snapshot. */
export function readVersionedExamples(classifierName: string, version: string): LabeledExample[] {
  const p = join(datasetDir(classifierName), `${version}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LabeledExample);
}

// ---------------------------------------------------------------------------
// Adding examples
// ---------------------------------------------------------------------------

export interface AddExampleOptions {
  label: string;
  confidence?: number;
  rationale?: string;
  source?: DataSource;
  annotator?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Add a labeled example to the dataset.
 * Returns the example that was written, or null if it was a duplicate.
 * Deduplication is by text SHA-256 — same text + same label = skip.
 */
export function addExample(
  classifierName: string,
  text: string,
  opts: AddExampleOptions,
): LabeledExample | null {
  ensureDatasetDir(classifierName);

  const id = textId(text);
  const existing = readExamples(classifierName);

  // Deduplicate: same id + same label = skip
  if (existing.some((e) => e.id === id && e.label === opts.label)) {
    return null;
  }

  const example: LabeledExample = {
    id,
    text,
    label: opts.label,
    confidence: opts.confidence ?? 1.0,
    rationale: opts.rationale,
    source: opts.source ?? "human",
    annotator: opts.annotator,
    labeled_at: new Date().toISOString(),
    metadata: opts.metadata ?? {},
  };

  appendFileSync(headDataPath(classifierName), JSON.stringify(example) + "\n", "utf8");

  // Update manifest timestamp
  const manifest = loadManifest(classifierName);
  manifest.updated_at = new Date().toISOString();
  saveManifest(classifierName, manifest);

  return example;
}

/**
 * Bulk-import from a JSONL file.
 * Each line must be a JSON object with at least `text` and `label`.
 * Returns { added, skipped }.
 */
export function importJsonl(
  classifierName: string,
  jsonlPath: string,
  source: DataSource = "human",
): { added: number; skipped: number } {
  if (!existsSync(jsonlPath)) {
    throw new Error(`Import file not found: ${jsonlPath}`);
  }

  const lines = readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
  let added = 0;
  let skipped = 0;

  for (const line of lines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      skipped++;
      continue;
    }

    const text = typeof row["text"] === "string" ? row["text"] : null;
    const label = typeof row["label"] === "string" ? row["label"] : null;
    if (!text || !label) { skipped++; continue; }

    const result = addExample(classifierName, text, {
      label,
      confidence: typeof row["confidence"] === "number" ? row["confidence"] : 1.0,
      rationale: typeof row["rationale"] === "string" ? row["rationale"] : undefined,
      source,
      annotator: typeof row["annotator"] === "string" ? row["annotator"] : undefined,
    });

    result ? added++ : skipped++;
  }

  return { added, skipped };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Compute statistics for a set of labeled examples. */
export function computeStats(examples: LabeledExample[]): DatasetStats {
  const dist: Record<string, number> = {};
  let totalTokens = 0;
  let uncertainCount = 0;
  const seenIds = new Set<string>();
  let duplicateCount = 0;
  const vocab = new Set<string>();

  for (const ex of examples) {
    dist[ex.label] = (dist[ex.label] ?? 0) + 1;
    const tokens = ex.text.trim().split(/\s+/);
    totalTokens += tokens.length;
    for (const t of tokens) vocab.add(t.toLowerCase());
    if (ex.confidence >= 0.35 && ex.confidence <= 0.65) uncertainCount++;
    if (seenIds.has(ex.id)) {
      duplicateCount++;
    } else {
      seenIds.add(ex.id);
    }
  }

  const counts = Object.values(dist);
  const minCount = counts.length ? Math.min(...counts) : 0;
  const maxCount = counts.length ? Math.max(...counts) : 1;
  const balanceScore = maxCount > 0 ? minCount / maxCount : 1;

  return {
    total: examples.length,
    label_distribution: dist,
    avg_token_length: examples.length > 0 ? totalTokens / examples.length : 0,
    balance_score: balanceScore,
    uncertain_count: uncertainCount,
    duplicate_count: duplicateCount,
    vocab_size: vocab.size,
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Export the HEAD dataset as JSONL to a target file.
 * The output is directly loadable by PyArrow, DuckDB, and Hugging Face datasets.
 */
export function exportJsonl(classifierName: string, outputPath: string): number {
  const examples = readExamples(classifierName);
  writeFileSync(outputPath, examples.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return examples.length;
}

// ---------------------------------------------------------------------------
// Manifest accessors
// ---------------------------------------------------------------------------

export function getManifest(classifierName: string): DatasetManifest {
  return loadManifest(classifierName);
}

export function listDatasets(): string[] {
  const base = join(tgDataDir(), "datasets");
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((name) => {
    try {
      return statSync(join(base, name)).isDirectory();
    } catch {
      return false;
    }
  });
}
