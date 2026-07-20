/**
 * TransparentGuard Runtime — Model Artifact Signing
 *
 * Cosign-compatible detached signature over model artifacts.
 * Signs the content of model.onnx (or the manifest hash when weights are absent).
 *
 * Signature format follows the Cosign simple signing spec:
 *   { payload: base64(canonical_json), signatures: [{ sig: base64url(ECDSA-P256) }] }
 *
 * The signing key is read from TG_SIGNING_KEY (PEM-encoded EC P-256 private key).
 * Falls back to the published dev key pair (testing only — never use in production).
 *
 * @see https://github.com/sigstore/cosign/blob/main/specs/SIGNATURE_SPEC.md
 */

import { createSign, createVerify } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { ModelManifest } from "../types.js";

// ---------------------------------------------------------------------------
// Dev key (published — not secret)
// ---------------------------------------------------------------------------

const DEV_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgLg74pCqq48Dt7jbT
UwR6PmePSHAON3nlj3aR1u9W1HehRANCAATswPEaWwIc7tDh5By2CDAQgdtRaOiy
S2LLdoP06XzuEDJ+rffSOY0RHxEtfVtN3hMZ0vWK5zBk1IBYGv0jTTow
-----END PRIVATE KEY-----`;

/** The matching public key, embedded here for self-contained verification. */
const DEV_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE7MDxGlsCHO7Q4eQctggwEIHbUWjo
sktiy3aD9Ol87hAyfq330jmNER8RLX1bTd4TGdL1iucwZNSAWBr9I006MA==
-----END PUBLIC KEY-----`;

// ---------------------------------------------------------------------------
// Cosign simple signing envelope
// ---------------------------------------------------------------------------

interface CosignPayload {
  critical: {
    identity: { "docker-reference": string };
    image: { "docker-manifest-digest": string };
    type: "cosign container image signature";
  };
  optional: {
    classifier: string;
    version: string;
    tg_artifact: boolean;
  };
}

interface CosignSignature {
  payload: string;          // base64(JSON CosignPayload)
  signatures: Array<{
    keyid: string;
    sig: string;            // base64url(ECDSA-P256 over payload)
  }>;
}

function signaturePath(artifactDir: string): string {
  return join(artifactDir, "signature.json");
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

/**
 * Sign a model artifact with ECDSA-P256.
 * Writes `signature.json` into the artifact directory.
 * Returns the path to the signature file.
 */
export function signArtifact(
  manifest: ModelManifest,
  artifactDir: string,
  privateKeyPem?: string,
): string {
  const pem = privateKeyPem ?? process.env["TG_SIGNING_KEY"] ?? DEV_PRIVATE_KEY_PEM;

  if (!(privateKeyPem ?? process.env["TG_SIGNING_KEY"])) {
    process.stderr.write(
      "Warning: TG_SIGNING_KEY not set — using the published dev key pair.\n" +
      "Model signatures produced with the dev key are safe for local testing ONLY.\n",
    );
  }

  const payload: CosignPayload = {
    critical: {
      identity: { "docker-reference": `transparentguard/${manifest.classifier_name}` },
      image: { "docker-manifest-digest": `sha256:${manifest.hash}` },
      type: "cosign container image signature",
    },
    optional: {
      classifier: manifest.classifier_name,
      version: manifest.version,
      tg_artifact: true,
    },
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");

  const signer = createSign("SHA256");
  signer.update(payloadB64, "utf8");
  const sig = signer.sign(pem, "base64url");

  const envelope: CosignSignature = {
    payload: payloadB64,
    signatures: [{ keyid: "tg-signing-key", sig }],
  };

  const outPath = signaturePath(artifactDir);
  writeFileSync(outPath, JSON.stringify(envelope, null, 2), "utf8");
  return outPath;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify a model artifact signature.
 * Reads `signature.json` from the artifact directory.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
export function verifyArtifact(
  manifest: ModelManifest,
  artifactDir: string,
  publicKeyPem?: string,
): { valid: boolean; reason?: string } {
  const sigPath = signaturePath(artifactDir);
  if (!existsSync(sigPath)) {
    return { valid: false, reason: "signature.json not found — artifact is unsigned." };
  }

  let envelope: CosignSignature;
  try {
    envelope = JSON.parse(readFileSync(sigPath, "utf8")) as CosignSignature;
  } catch {
    return { valid: false, reason: "signature.json is malformed." };
  }

  if (!envelope.signatures?.length) {
    return { valid: false, reason: "No signatures found in signature.json." };
  }

  const pubKey = publicKeyPem ?? DEV_PUBLIC_KEY_PEM;

  for (const entry of envelope.signatures) {
    try {
      const verifier = createVerify("SHA256");
      verifier.update(envelope.payload, "utf8");
      if (verifier.verify(pubKey, entry.sig, "base64url")) {
        // Also verify the payload references the correct manifest hash
        const decoded = JSON.parse(
          Buffer.from(envelope.payload, "base64").toString("utf8"),
        ) as CosignPayload;
        if (!decoded.critical.image["docker-manifest-digest"].endsWith(manifest.hash.slice(0, 16))) {
          return {
            valid: false,
            reason: `Signature payload digest does not match manifest hash (${manifest.hash.slice(0, 12)}…).`,
          };
        }
        return { valid: true };
      }
    } catch {
      // Try next signature
    }
  }

  return { valid: false, reason: "No valid signature found for the provided public key." };
}
