/**
 * TransparentGuard Runtime — Model Artifact Store
 *
 * Content-addressed artifact storage for trained classifier models.
 *
 * Directory layout:
 *   ~/.tg/models/<classifier-name>/<version>/
 *     model.onnx          ONNX weights file (present after training completes)
 *     manifest.json       ModelManifest — provenance, metrics, signing status
 *     model.card.json     Hugging Face-compatible model card
 *     signature.json      Cosign-compatible detached signature (when signed)
 *     drift-window.ndjson Rolling inference window for drift detection
 *
 * All artifact directories are content-addressed by the SHA-256 of model.onnx.
 * When weights are not yet available (job pending), `hash` is "pending".
 *
 * Versions are monotonically incrementing: v1, v2, v3, ...
 * HEAD always points to the latest version via a HEAD symlink-equivalent in index.json.
 */

import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  statSync,
} from "fs";
import { join } from "path";
import { tgDataDir } from "../dataset/store.js";
import type { ModelManifest, ModelArtifact, ModelCard } from "../types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function modelsBaseDir(): string {
  return join(tgDataDir(), "models");
}

export function modelDir(classifierName: string): string {
  const safe = classifierName.replace(/[^a-zA-Z0-9_\-./]/g, "_");
  return join(modelsBaseDir(), safe);
}

export function artifactDir(classifierName: string, version: string): string {
  return join(modelDir(classifierName), version);
}

function manifestPath(classifierName: string, version: string): string {
  return join(artifactDir(classifierName, version), "manifest.json");
}

function cardPath(classifierName: string, version: string): string {
  return join(artifactDir(classifierName, version), "model.card.json");
}

function weightsPath(classifierName: string, version: string): string {
  return join(artifactDir(classifierName, version), "model.onnx");
}

function indexPath(classifierName: string): string {
  return join(modelDir(classifierName), "index.json");
}

// ---------------------------------------------------------------------------
// Index — HEAD pointer
// ---------------------------------------------------------------------------

interface ModelIndex {
  classifier_name: string;
  head: string;
  versions: string[];
}

function loadIndex(classifierName: string): ModelIndex | null {
  const p = indexPath(classifierName);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as ModelIndex;
}

function saveIndex(classifierName: string, index: ModelIndex): void {
  writeFileSync(indexPath(classifierName), JSON.stringify(index, null, 2), "utf8");
}

function nextVersion(classifierName: string): string {
  const idx = loadIndex(classifierName);
  return `v${(idx?.versions.length ?? 0) + 1}`;
}

// ---------------------------------------------------------------------------
// SHA-256 of weights file
// ---------------------------------------------------------------------------

export function weightsHash(classifierName: string, version: string): string {
  const p = weightsPath(classifierName, version);
  if (!existsSync(p)) return "pending";
  const buf = readFileSync(p);
  return createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// Create artifact
// ---------------------------------------------------------------------------

/**
 * Register a new model artifact.
 * Called after a training job completes (with or without actual weights).
 * Returns the created ModelArtifact.
 */
export function createArtifact(
  classifierName: string,
  manifest: Omit<ModelManifest, "version" | "hash" | "created_at">,
  card: ModelCard,
  onnxSourcePath?: string,
): ModelArtifact {
  const version = nextVersion(classifierName);
  const dir = artifactDir(classifierName, version);
  mkdirSync(dir, { recursive: true });

  // Copy ONNX weights if provided
  if (onnxSourcePath && existsSync(onnxSourcePath)) {
    copyFileSync(onnxSourcePath, weightsPath(classifierName, version));
  }

  const hash = weightsHash(classifierName, version);
  const now = new Date().toISOString();

  const fullManifest: ModelManifest = {
    ...manifest,
    classifier_name: classifierName,
    version,
    hash,
    created_at: now,
    signed: false,
  };

  writeFileSync(manifestPath(classifierName, version), JSON.stringify(fullManifest, null, 2), "utf8");
  writeFileSync(cardPath(classifierName, version), JSON.stringify(card, null, 2), "utf8");

  // Update index
  const idx = loadIndex(classifierName) ?? {
    classifier_name: classifierName,
    head: version,
    versions: [],
  };
  idx.versions.push(version);
  idx.head = version;
  saveIndex(classifierName, idx);

  const wp = weightsPath(classifierName, version);
  return {
    manifest: fullManifest,
    artifact_dir: dir,
    weights_path: existsSync(wp) ? wp : undefined,
    card_path: cardPath(classifierName, version),
  };
}

// ---------------------------------------------------------------------------
// Load artifact
// ---------------------------------------------------------------------------

/**
 * Load a model artifact by classifier name and version.
 * Pass "HEAD" (or omit version) to load the latest.
 */
export function loadArtifact(
  classifierName: string,
  version = "HEAD",
): ModelArtifact | null {
  const resolvedVersion = resolveVersion(classifierName, version);
  if (!resolvedVersion) return null;

  const mp = manifestPath(classifierName, resolvedVersion);
  if (!existsSync(mp)) return null;

  const manifest = JSON.parse(readFileSync(mp, "utf8")) as ModelManifest;
  const dir = artifactDir(classifierName, resolvedVersion);
  const wp = weightsPath(classifierName, resolvedVersion);

  return {
    manifest,
    artifact_dir: dir,
    weights_path: existsSync(wp) ? wp : undefined,
    card_path: cardPath(classifierName, resolvedVersion),
  };
}

/** Resolve "HEAD" or a version string to a concrete version. */
export function resolveVersion(classifierName: string, version: string): string | null {
  const idx = loadIndex(classifierName);
  if (!idx) return null;
  if (version === "HEAD") return idx.head;
  return idx.versions.includes(version) ? version : null;
}

/**
 * Update the manifest for an existing artifact (e.g. after signing).
 */
export function updateManifest(
  classifierName: string,
  version: string,
  updates: Partial<ModelManifest>,
): void {
  const p = manifestPath(classifierName, version);
  if (!existsSync(p)) throw new Error(`Artifact not found: ${classifierName}@${version}`);
  const existing = JSON.parse(readFileSync(p, "utf8")) as ModelManifest;
  writeFileSync(p, JSON.stringify({ ...existing, ...updates }, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * List all classifiers that have model artifacts.
 */
export function listModelClassifiers(): string[] {
  const base = modelsBaseDir();
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((name) => {
    try { return statSync(join(base, name)).isDirectory(); } catch { return false; }
  });
}

/**
 * List all artifact versions for a classifier.
 */
export function listArtifactVersions(classifierName: string): string[] {
  return loadIndex(classifierName)?.versions ?? [];
}

/**
 * Set the HEAD pointer for a classifier to a specific version.
 * Used by rollback.
 */
export function setHead(classifierName: string, version: string): void {
  const idx = loadIndex(classifierName);
  if (!idx) throw new Error(`No model index found for "${classifierName}".`);
  if (!idx.versions.includes(version)) {
    throw new Error(`Version "${version}" not found for classifier "${classifierName}".`);
  }
  idx.head = version;
  saveIndex(classifierName, idx);
}

/**
 * Format model list for terminal output.
 */
export function formatModelList(): string {
  const classifiers = listModelClassifiers();
  if (classifiers.length === 0) return "\nNo trained models found.\n";

  const lines: string[] = ["\nTrained models\n"];
  for (const name of classifiers) {
    const artifact = loadArtifact(name, "HEAD");
    if (!artifact) continue;
    const m = artifact.manifest;
    const hasWeights = artifact.weights_path ? "✓ weights" : "○ pending weights";
    const signed = m.signed ? "✓ signed" : "○ unsigned";
    lines.push(`  ${name}`);
    lines.push(`    Version : ${m.version}  Hash: ${m.hash.slice(0, 12)}…`);
    lines.push(`    Arch    : ${m.architecture}  Backend: ${m.backend}`);
    lines.push(`    Status  : ${hasWeights}  ${signed}`);
    lines.push(`    Created : ${m.created_at}`);
  }
  lines.push("");
  return lines.join("\n");
}
