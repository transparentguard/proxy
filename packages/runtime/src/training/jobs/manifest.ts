/**
 * TransparentGuard Runtime — SLSA L2 Provenance Manifest Builder
 *
 * Generates a SLSA-compatible provenance document for every training job.
 * The document attests: what dataset was used, what backend, what architecture,
 * when the job ran, and what artifact was produced.
 *
 * Provenance is signed with ECDSA-P256 (same key pair as evaluation receipts).
 * The signature covers the canonical JSON of the provenance subject + definition.
 *
 * @see https://slsa.dev/spec/v1.0/provenance
 */

import { createSign, createVerify } from "crypto";
import { existsSync, readFileSync } from "fs";
import type { SLSAProvenance, TrainingJob, ModelManifest } from "../types.js";

// ---------------------------------------------------------------------------
// Runtime version (keep in sync with package.json)
// ---------------------------------------------------------------------------

const RUNTIME_VERSION = "0.1.1";

// ---------------------------------------------------------------------------
// Provenance builder
// ---------------------------------------------------------------------------

/**
 * Build a SLSA L2-compatible provenance document for a completed training job.
 * The document is unsigned by default — call `signProvenance` to attach a signature.
 */
export function buildProvenance(
  job: TrainingJob,
  modelManifest: ModelManifest,
  hyperparameters: Record<string, unknown> = {},
  tags: Record<string, string> = {},
): SLSAProvenance {
  return {
    build_type: "https://transparentguard.dev/slsa/training/v1",
    provenance_level: "SLSA_L2",
    subject: {
      name: `tg-model:${job.classifier_name}@${modelManifest.version}`,
      digest: { sha256: modelManifest.hash },
    },
    build_definition: {
      classifier_name: job.classifier_name,
      dataset_hash: job.dataset_hash,
      dataset_version: job.dataset_version,
      backend: job.backend,
      architecture: modelManifest.architecture,
      hyperparameters,
      tags,
    },
    run_details: {
      job_id: job.job_id,
      started_at: job.started_at ?? job.created_at,
      completed_at: job.completed_at ?? new Date().toISOString(),
      runtime_version: RUNTIME_VERSION,
    },
    generated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Canonical JSON serialization
// ---------------------------------------------------------------------------

/**
 * Produce a canonical (sorted-key, no-whitespace) JSON string of the
 * provenance fields that are covered by the signature.
 * Excludes the `signature` field itself.
 */
function canonicalProvenance(p: SLSAProvenance): string {
  const { signature: _sig, ...unsigned } = p;
  return JSON.stringify(unsigned, Object.keys(unsigned).sort() as never);
}

// ---------------------------------------------------------------------------
// Signing and verification
// ---------------------------------------------------------------------------

/**
 * Sign a SLSA provenance document with an ECDSA-P256 private key PEM.
 * The private key is read from the TG_SIGNING_KEY environment variable,
 * or falls back to the published dev key (testing only).
 *
 * Returns the provenance document with the `signature` field populated.
 */
export function signProvenance(
  provenance: SLSAProvenance,
  privateKeyPem?: string,
): SLSAProvenance {
  const pem = privateKeyPem ?? getSigningKey();
  const canonical = canonicalProvenance(provenance);
  const signer = createSign("SHA256");
  signer.update(canonical, "utf8");
  const sig = signer.sign(pem, "base64url");
  return { ...provenance, signature: sig };
}

/**
 * Verify a signed SLSA provenance document.
 * Returns true if the signature is valid.
 */
export function verifyProvenance(
  provenance: SLSAProvenance,
  publicKeyPem: string,
): boolean {
  if (!provenance.signature) return false;
  try {
    const canonical = canonicalProvenance(provenance);
    const verifier = createVerify("SHA256");
    verifier.update(canonical, "utf8");
    return verifier.verify(publicKeyPem, provenance.signature, "base64url");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

/**
 * The published dev private key — safe to embed because it is already
 * public in the open-source repository. For production, set TG_SIGNING_KEY.
 */
const DEV_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgLg74pCqq48Dt7jbT
UwR6PmePSHAON3nlj3aR1u9W1HehRANCAATswPEaWwIc7tDh5By2CDAQgdtRaOiy
S2LLdoP06XzuEDJ+rffSOY0RHxEtfVtN3hMZ0vWK5zBk1IBYGv0jTTow
-----END PRIVATE KEY-----`;

function getSigningKey(): string {
  return process.env["TG_SIGNING_KEY"] ?? DEV_PRIVATE_KEY_PEM;
}

/**
 * Format a provenance document for terminal display.
 */
export function formatProvenance(p: SLSAProvenance): string {
  const lines: string[] = ["\nSLSA Provenance Document\n"];
  lines.push(`  Level      : ${p.provenance_level}`);
  lines.push(`  Subject    : ${p.subject.name}`);
  lines.push(`  Digest     : sha256:${p.subject.digest.sha256.slice(0, 16)}…`);
  lines.push(`  Classifier : ${p.build_definition.classifier_name}`);
  lines.push(`  Dataset    : ${p.build_definition.dataset_hash.slice(0, 16)}… (${p.build_definition.dataset_version})`);
  lines.push(`  Backend    : ${p.build_definition.backend}`);
  lines.push(`  Arch       : ${p.build_definition.architecture}`);
  lines.push(`  Job        : ${p.run_details.job_id}`);
  lines.push(`  Started    : ${p.run_details.started_at}`);
  lines.push(`  Completed  : ${p.run_details.completed_at}`);
  lines.push(`  Runtime    : tg v${p.run_details.runtime_version}`);
  lines.push(`  Generated  : ${p.generated_at}`);
  lines.push(`  Signed     : ${p.signature ? `yes (${p.signature.slice(0, 16)}…)` : "no"}`);
  lines.push("");
  return lines.join("\n");
}
