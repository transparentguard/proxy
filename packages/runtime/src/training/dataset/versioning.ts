/**
 * TransparentGuard Runtime — Dataset Versioning
 *
 * Immutable, content-addressed dataset snapshots.
 * Every `tg dataset version` command creates a new snapshot by:
 *   1. Copying the HEAD JSONL to <version>.jsonl
 *   2. Computing the SHA-256 of the snapshot file
 *   3. Appending the new version to the manifest
 *   4. Advancing the HEAD pointer
 *
 * Snapshots are never modified. To reproduce any training run,
 * pin the dataset_hash in the TrainingSpec.
 */

import { existsSync, copyFileSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { datasetDir, fileHash, readExamples, computeStats, getManifest } from "./store.js";
import { validateDataset } from "./validator.js";
import type { DatasetVersion, DatasetManifest } from "../types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function manifestPath(classifierName: string): string {
  return join(datasetDir(classifierName), "manifest.json");
}

function headDataPath(classifierName: string): string {
  return join(datasetDir(classifierName), "head.jsonl");
}

function nextVersion(manifest: DatasetManifest): string {
  return `v${manifest.versions.length + 1}`;
}

// ---------------------------------------------------------------------------
// Snapshot creation
// ---------------------------------------------------------------------------

export interface SnapshotResult {
  version: DatasetVersion;
  manifest: DatasetManifest;
}

/**
 * Create an immutable snapshot of the current HEAD dataset.
 * Returns the new DatasetVersion and the updated manifest.
 * Throws if HEAD is empty or unchanged since the last snapshot.
 */
export function createSnapshot(classifierName: string): SnapshotResult {
  const dir = datasetDir(classifierName);
  const headPath = headDataPath(classifierName);

  if (!existsSync(headPath)) {
    throw new Error(
      `No HEAD dataset found for classifier "${classifierName}". ` +
      "Add examples first with `tg dataset add`.",
    );
  }

  const examples = readExamples(classifierName);
  if (examples.length === 0) {
    throw new Error(`HEAD dataset for "${classifierName}" is empty. Nothing to snapshot.`);
  }

  const manifest = getManifest(classifierName);
  const hash = fileHash(headPath);

  // Idempotent: if HEAD is unchanged since last snapshot, skip
  const lastVersion = manifest.versions[manifest.versions.length - 1];
  if (lastVersion && lastVersion.hash === hash) {
    throw new Error(
      `HEAD dataset is unchanged since snapshot ${lastVersion.version} (hash: ${hash.slice(0, 12)}…). ` +
      "Add or update examples before creating a new snapshot.",
    );
  }

  const version = nextVersion(manifest);
  const snapshotPath = join(dir, `${version}.jsonl`);
  copyFileSync(headPath, snapshotPath);

  const stats = computeStats(examples);
  const labels = [...new Set(examples.map((e) => e.label))].sort();
  const now = new Date().toISOString();

  const datasetVersion: DatasetVersion = {
    version,
    hash,
    created_at: now,
    example_count: examples.length,
    labels,
    stats,
  };

  manifest.versions.push(datasetVersion);
  manifest.head = version;
  manifest.updated_at = now;

  writeFileSync(manifestPath(classifierName), JSON.stringify(manifest, null, 2), "utf8");

  return { version: datasetVersion, manifest };
}

// ---------------------------------------------------------------------------
// Version inspection
// ---------------------------------------------------------------------------

/** List all immutable versions of a dataset. */
export function listVersions(classifierName: string): DatasetVersion[] {
  return getManifest(classifierName).versions;
}

/** Resolve a version string to a DatasetVersion. "HEAD" resolves to the latest. */
export function resolveVersion(
  classifierName: string,
  versionOrHash: string,
): DatasetVersion | undefined {
  const manifest = getManifest(classifierName);
  if (versionOrHash === "HEAD") {
    return manifest.versions[manifest.versions.length - 1];
  }
  return manifest.versions.find(
    (v) => v.version === versionOrHash || v.hash.startsWith(versionOrHash),
  );
}

/** Verify that a versioned snapshot file's hash still matches the manifest. */
export function verifySnapshot(classifierName: string, version: string): boolean {
  const v = resolveVersion(classifierName, version);
  if (!v) return false;
  const snapshotPath = join(datasetDir(classifierName), `${version}.jsonl`);
  if (!existsSync(snapshotPath)) return false;
  return fileHash(snapshotPath) === v.hash;
}

/**
 * Format a version list for terminal display.
 */
export function formatVersionList(classifierName: string, versions: DatasetVersion[]): string {
  if (versions.length === 0) {
    return `\nNo snapshots yet for "${classifierName}". Run \`tg dataset version ${classifierName}\`.\n`;
  }

  const lines: string[] = [`\nDataset snapshots — ${classifierName}\n`];
  for (const v of [...versions].reverse()) {
    const labels = v.labels.join(", ");
    lines.push(`  ${v.version.padEnd(4)}  ${v.hash.slice(0, 12)}…  ${v.example_count} examples  [${labels}]`);
    lines.push(`        Created: ${v.created_at}  Balance: ${v.stats.balance_score.toFixed(2)}`);
  }
  lines.push("");
  return lines.join("\n");
}
