/**
 * TransparentGuard Runtime — License Checker
 *
 * Verification priority (highest first):
 *   1. TG_LICENSE_KEY env var  → verifyOfflineKey (ECDSA-P256; zero network)
 *   2. Valid cache entry        → return cached status
 *   3. API check                → cache and return
 *   4. API unreachable          → grace cache (1 h) or hard fail
 *   5. No key                   → free tier
 *
 * Security properties:
 *   - Offline keys use ECDSA-P256. Only the *public* key is embedded here;
 *     signatures cannot be forged without the private key held by issuance tooling.
 *   - Online keys: fail-closed grace cache prevents silent free-tier downgrade
 *     during transient API outages.
 *   - Payload: every field is validated at runtime (not just TypeScript-cast).
 *   - Environment binding: TG_LICENSE_ENV rejects cross-environment key reuse.
 *   - Key age: keys older than 2 years are rejected regardless of exp field.
 */

import { createVerify } from "crypto";

// ---------------------------------------------------------------------------
// Runtime version — keep in sync with package.json               (fix #9)
// ---------------------------------------------------------------------------

const RUNTIME_VERSION = "0.1.1";

// ---------------------------------------------------------------------------
// ECDSA-P256 public key for offline key verification             (fix #1)
// ---------------------------------------------------------------------------
// SAFE TO EMBED: this is a *public* key. It can verify signatures but cannot
// produce them. The matching private key is stored exclusively in TG_SIGNING_KEY
// on the key-issuance machine and is never shipped with this runtime.
const OFFLINE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE7MDxGlsCHO7Q4eQctggwEIHbUWjo
sktiy3aD9Ol87hAyfq330jmNER8RLX1bTd4TGdL1iucwZNSAWBr9I006MA==
-----END PUBLIC KEY-----`;

// ---------------------------------------------------------------------------
// Whitelist sets for runtime payload validation                   (fix #3)
// ---------------------------------------------------------------------------

const VALID_TIERS = new Set([
  "free", "startup", "growth", "enterprise", "oem",
]);

const VALID_FEATURES = new Set([
  // Free tier — no features required
  // Startup tier
  "ml_classifiers", "semantic_targets", "confidentiality_check",
  "compliance_frameworks", "audit_s3", "audit_postgres", "audit_gcs",
  "audit_azure", "audit_chain_integrity", "threshold_notifications",
  "streaming_window",        // windowed + passthrough streaming modes
  "provider_risk_tier",      // risk_tier + capability filtering in provider_match
  // Growth tier
  "policy_registry", "pie",
  "multi_environment",       // separate policies per environment (dev/staging/production)
  "report_generation",       // tg report — structured evidence package export
  "custom_adapter",          // registerAdapter for non-standard LLM endpoints
  "classifier_bundle",       // tg classifiers pull — pre-bundled ML classifier download
  // Enterprise tier
  "fedramp", "trust_chain", "custom_classifier_training",
  "offline_mode",            // offline: true — zero outbound calls (requires offline key)
  "data_sovereignty",        // enforce_type: data_sovereignty + jurisdiction routing
  "blocked_training_jurisdictions", // blocked_training_jurisdictions in provider_match
  // OEM tier
  "oem_embed",
]);

// ---------------------------------------------------------------------------
// Timing constants for offline key validation                     (fix #5)
// ---------------------------------------------------------------------------

/** Max age of an offline key regardless of exp field (2 years). */
const MAX_KEY_AGE_SEC = 730 * 24 * 60 * 60;
/** Allowed clock skew for iat future-date check (5 minutes). */
const CLOCK_SKEW_SEC = 5 * 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LicenseTier = "free" | "startup" | "growth" | "enterprise" | "oem";

export interface LicenseStatus {
  valid: boolean;
  tier: LicenseTier;
  trialActive: boolean;
  trialExpiresAt?: Date;
  features: LicenseFeature[];
  checkedAt: Date;
}

export type LicenseFeature =
  // Startup tier
  | "ml_classifiers"
  | "semantic_targets"
  | "confidentiality_check"
  | "compliance_frameworks"
  | "audit_s3"
  | "audit_postgres"
  | "audit_gcs"
  | "audit_azure"
  | "audit_chain_integrity"
  | "threshold_notifications"
  | "streaming_window"               // windowed + passthrough streaming modes
  | "provider_risk_tier"             // risk_tier + capability filtering in provider_match
  // Growth tier
  | "policy_registry"
  | "pie"
  | "multi_environment"              // separate policies per environment
  | "report_generation"              // tg report — structured evidence package export
  | "custom_adapter"                 // registerAdapter for non-standard LLM endpoints
  | "classifier_bundle"              // tg classifiers pull — pre-bundled ML classifier download
  // Enterprise tier
  | "fedramp"
  | "trust_chain"
  | "custom_classifier_training"
  | "offline_mode"                   // offline: true — zero outbound calls
  | "data_sovereignty"               // enforce_type: data_sovereignty
  | "blocked_training_jurisdictions" // blocked_training_jurisdictions in provider_match
  // OEM tier
  | "oem_embed";

export class TransparentGuardError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "trial_expired"
      | "invalid_key"
      | "rate_limited"
      | "api_unreachable"
      | "feature_requires_paid_tier"
      | "policy_violation",
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "TransparentGuardError";
  }
}

interface OfflineLicensePayload {
  v: 1;
  tier: LicenseTier;
  features: LicenseFeature[];
  cid: string;
  iat: number;
  exp: number;
  env?: string;
}

// ---------------------------------------------------------------------------
// Runtime payload validation                                      (fix #3)
// ---------------------------------------------------------------------------

function validateOfflinePayload(raw: unknown): OfflineLicensePayload {
  const fail = (msg: string): never => {
    throw new TransparentGuardError(
      `Offline license key payload is invalid: ${msg}`,
      "invalid_key",
    );
  };

  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    fail("must be a JSON object");

  const p = raw as Record<string, unknown>;

  if (p["v"] !== 1)
    fail(`unsupported version "${String(p["v"])}" — expected 1`);

  if (typeof p["tier"] !== "string" || !VALID_TIERS.has(p["tier"] as string))
    fail(`unknown tier "${String(p["tier"])}"`);

  if (!Array.isArray(p["features"]))
    fail("features must be an array");

  for (const f of p["features"] as unknown[]) {
    if (typeof f !== "string" || !VALID_FEATURES.has(f))
      fail(`unknown feature "${String(f)}"`);
  }

  if (typeof p["cid"] !== "string" || !(p["cid"] as string).trim())
    fail("cid must be a non-empty string");

  if (
    typeof p["iat"] !== "number" ||
    !Number.isFinite(p["iat"]) ||
    (p["iat"] as number) <= 0
  ) fail("iat must be a positive finite number");

  if (
    typeof p["exp"] !== "number" ||
    !Number.isFinite(p["exp"]) ||
    (p["exp"] as number) <= 0
  ) fail("exp must be a positive finite number");

  if (
    p["env"] !== undefined &&
    (typeof p["env"] !== "string" || !(p["env"] as string).trim())
  ) fail("env must be a non-empty string if present");

  return p as unknown as OfflineLicensePayload;
}

// ---------------------------------------------------------------------------
// Offline key verification                            (fixes #1 #3 #4 #5)
// ---------------------------------------------------------------------------

/**
 * Verifies an offline license key (tgk1_... format) and returns a LicenseStatus.
 * Throws TransparentGuardError if the key is invalid, tampered, expired, or
 * issued for a different environment.
 */
export function verifyOfflineKey(licenseKey: string): LicenseStatus {
  if (!licenseKey.startsWith("tgk1_")) {
    throw new TransparentGuardError(
      "Invalid offline license key format — expected prefix tgk1_. " +
        "Generate a key with `tg keys create` or check transparentguard.dev.",
      "invalid_key",
    );
  }

  const without = licenseKey.slice("tgk1_".length);
  const dotIdx = without.lastIndexOf(".");
  if (dotIdx === -1) {
    throw new TransparentGuardError(
      "Invalid offline license key — missing signature component.",
      "invalid_key",
    );
  }

  const payloadB64 = without.slice(0, dotIdx);
  const providedSig = without.slice(dotIdx + 1);

  // Fix #1 — ECDSA-P256 verification. The public key cannot forge signatures.
  let sigValid: boolean;
  try {
    const verifier = createVerify("SHA256");
    verifier.update(payloadB64, "utf8");
    sigValid = verifier.verify(OFFLINE_PUBLIC_KEY_PEM, providedSig, "base64url");
  } catch {
    sigValid = false;
  }

  if (!sigValid) {
    throw new TransparentGuardError(
      "Offline license key signature verification failed. " +
        "The key may be corrupted or was not issued by TransparentGuard.",
      "invalid_key",
    );
  }

  // Decode payload
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    );
  } catch {
    throw new TransparentGuardError(
      "Offline license key payload could not be decoded.",
      "invalid_key",
    );
  }

  // Fix #3 — full runtime field validation (not a bare TypeScript cast)
  const payload = validateOfflinePayload(rawPayload);

  const nowSec = Math.floor(Date.now() / 1000);

  // Fix #5 — reject keys with a future iat (clock skew tolerance: 5 min)
  if (payload.iat > nowSec + CLOCK_SKEW_SEC) {
    throw new TransparentGuardError(
      `Offline license key has a future issue time ` +
        `(iat: ${new Date(payload.iat * 1000).toISOString()}). ` +
        "Verify your system clock is correct.",
      "invalid_key",
    );
  }

  // Fix #5 — reject keys older than 2 years regardless of exp
  if (nowSec - payload.iat > MAX_KEY_AGE_SEC) {
    throw new TransparentGuardError(
      `Offline license key is too old ` +
        `(issued ${new Date(payload.iat * 1000).toISOString()}). ` +
        "Generate a fresh key with `tg keys create`.",
      "invalid_key",
    );
  }

  // Standard expiry
  if (payload.exp < nowSec) {
    throw new TransparentGuardError(
      `Offline license key expired at ${new Date(payload.exp * 1000).toISOString()}. ` +
        "Generate a new key with `tg keys create` or upgrade at transparentguard.dev.",
      "trial_expired",
    );
  }

  // Fix #4 — environment binding: reject cross-environment key reuse
  const expectedEnv = process.env["TG_LICENSE_ENV"];
  if (payload.env && expectedEnv && payload.env !== expectedEnv) {
    throw new TransparentGuardError(
      `Offline license key is scoped to environment "${payload.env}" ` +
        `but this runtime has TG_LICENSE_ENV="${expectedEnv}". ` +
        "Use the correct key for this environment.",
      "invalid_key",
    );
  }

  return {
    valid: true,
    tier: payload.tier,
    trialActive: false,
    features: payload.features,
    checkedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Cache                                                    (fixes #7 #8)
// ---------------------------------------------------------------------------

interface CacheEntry {
  status: LicenseStatus;
  expiresAt: number;
}

// Fix #8 — configurable TTL via TG_LICENSE_CACHE_TTL_SEC (default 5 min)
const CACHE_TTL_MS: number = (() => {
  const v = parseInt(process.env["TG_LICENSE_CACHE_TTL_SEC"] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v * 1000 : 5 * 60 * 1000;
})();

const GRACE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Fix #7 — bounded maps: max 500 entries; evict oldest 10% when full
const MAX_CACHE_ENTRIES = 500;

function evictOldest(map: Map<string, CacheEntry>): void {
  if (map.size < MAX_CACHE_ENTRIES) return;
  const toEvict = Math.ceil(MAX_CACHE_ENTRIES * 0.1);
  let n = 0;
  for (const key of map.keys()) {
    map.delete(key);
    if (++n >= toEvict) break;
  }
}

const cache = new Map<string, CacheEntry>();
const graceCache = new Map<string, CacheEntry>();

function getCached(apiKey: string): LicenseStatus | null {
  const entry = cache.get(apiKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(apiKey); return null; }
  return entry.status;
}

function setCached(apiKey: string, status: LicenseStatus): void {
  evictOldest(cache);
  cache.set(apiKey, { status, expiresAt: Date.now() + CACHE_TTL_MS });
  setGraceCached(apiKey, status); // refresh grace window on every success
}

function getGraceCached(apiKey: string): LicenseStatus | null {
  const entry = graceCache.get(apiKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { graceCache.delete(apiKey); return null; }
  return entry.status;
}

function setGraceCached(apiKey: string, status: LicenseStatus): void {
  evictOldest(graceCache);
  graceCache.set(apiKey, { status, expiresAt: Date.now() + GRACE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Free tier factory                                               (fix #10)
// ---------------------------------------------------------------------------

/** Always returns a fresh LicenseStatus — checkedAt is never stale. */
function makeFreeStatus(): LicenseStatus {
  return {
    valid: true,
    tier: "free",
    trialActive: false,
    features: [],
    checkedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Serverless detection                                            (fix #6)
// ---------------------------------------------------------------------------

function isServerlessEnvironment(): boolean {
  return !!(
    process.env["AWS_LAMBDA_FUNCTION_NAME"] ||
    process.env["VERCEL"] ||
    process.env["NETLIFY"] ||
    process.env["FUNCTION_TARGET"] ||   // Google Cloud Functions
    process.env["WEBSITE_INSTANCE_ID"]  // Azure Functions
  );
}

let _serverlessWarned = false;
function warnServerlessOnce(): void {
  if (_serverlessWarned || !isServerlessEnvironment()) return;
  _serverlessWarned = true;
  console.warn(
    "[TransparentGuard] Serverless environment detected. " +
      "The in-memory license cache resets on every cold start — " +
      "the 1-hour grace window will be empty until the first successful API check completes. " +
      "For reliable air-gapped operation in serverless, use TG_LICENSE_KEY instead.",
  );
}

// ---------------------------------------------------------------------------
// Online API check                                                (fix #9)
// ---------------------------------------------------------------------------

interface LicenseApiResponse {
  valid: boolean;
  tier: LicenseTier;
  trial_active: boolean;
  trial_expires_at?: string;
  features: LicenseFeature[];
}

const CHECK_TIMEOUT_MS = 5_000;
const DEFAULT_API_BASE = "https://api.transparentguard.dev";

async function checkApiKey(
  apiKey: string,
  apiBaseUrl: string,
): Promise<LicenseStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(`${apiBaseUrl}/v1/license/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        // Fix #9 — use the actual runtime version constant, not a stale literal
        "User-Agent": `transparentguard-runtime/${RUNTIME_VERSION}`,
      },
      body: JSON.stringify({ runtime_version: RUNTIME_VERSION }),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      const code = String(body["code"] ?? "");
      if (code === "trial_expired") {
        throw new TransparentGuardError(
          "Your TransparentGuard trial has ended. Upgrade at transparentguard.dev to continue.",
          "trial_expired",
        );
      }
      throw new TransparentGuardError(
        "Invalid TransparentGuard API key. Check your key at transparentguard.dev.",
        "invalid_key",
      );
    }

    if (response.status === 429) {
      throw new TransparentGuardError(
        "TransparentGuard license check rate limited. Retrying with cached status.",
        "rate_limited",
      );
    }

    if (!response.ok) {
      throw new TransparentGuardError(
        `TransparentGuard API returned ${response.status}.`,
        "api_unreachable",
      );
    }

    const data = await response.json() as LicenseApiResponse;
    const status: LicenseStatus = {
      valid: data.valid,
      tier: data.tier,
      trialActive: data.trial_active,
      trialExpiresAt: data.trial_expires_at
        ? new Date(data.trial_expires_at)
        : undefined,
      features: data.features,
      checkedAt: new Date(),
    };

    if (status.trialActive === false && status.tier === "free" && !data.valid) {
      throw new TransparentGuardError(
        "Your TransparentGuard trial has ended. Upgrade at transparentguard.dev to continue.",
        "trial_expired",
      );
    }

    return status;
  } catch (err) {
    if (err instanceof TransparentGuardError) throw err;
    throw new TransparentGuardError(
      `Cannot reach TransparentGuard API: ${String(err)}`,
      "api_unreachable",
    );
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Checks the license status for the given API key.
 *
 * @param apiKey     Your TransparentGuard API key (Bearer token).
 * @param apiBaseUrl Override the API base URL (testing only).
 * @param offlineMode @deprecated No longer grants paid features.
 *                    Set TG_LICENSE_KEY to an offline key instead.
 *                    Will be removed in v0.5.0.
 */
export async function checkLicense(
  apiKey: string | undefined,
  apiBaseUrl: string = DEFAULT_API_BASE,
  offlineMode = false,
): Promise<LicenseStatus> {
  // 1. Offline key — highest priority, no network call.
  const offlineLicenseKey = process.env["TG_LICENSE_KEY"];
  if (offlineLicenseKey) {
    return verifyOfflineKey(offlineLicenseKey);
  }

  // Fix #11 / #2 — offlineMode no longer grants enterprise unconditionally.
  // Previously this was an undocumented bypass that granted all paid features
  // with no verification. It now degrades to free tier with a deprecation warning.
  if (offlineMode) {
    console.warn(
      "[TransparentGuard] The `offlineMode` parameter is deprecated and will be removed in v0.5.0. " +
        "It no longer grants paid features — use TG_LICENSE_KEY with an offline key instead. " +
        "See: https://transparentguard.dev/docs/offline-license",
    );
    return makeFreeStatus();
  }

  // 2. No key at all — free tier.
  if (!apiKey) return makeFreeStatus();

  // Fix #6 — emit a one-time warning in serverless runtimes.
  warnServerlessOnce();

  // 3. Cache hit.
  const cached = getCached(apiKey);
  if (cached) return cached;

  // 4. API check.
  try {
    const status = await checkApiKey(apiKey, apiBaseUrl);
    setCached(apiKey, status);
    return status;
  } catch (err) {
    if (err instanceof TransparentGuardError) {
      if (err.code === "api_unreachable" || err.code === "rate_limited") {
        const graceStatus = getGraceCached(apiKey);
        if (graceStatus) {
          console.warn(
            `[TransparentGuard] ${err.message} Using cached license status (grace window active).`,
          );
          return graceStatus;
        }
        // No grace status — hard fail. Give extra context in serverless.
        throw new TransparentGuardError(
          "TransparentGuard license server unreachable and no cached status is available. " +
            (isServerlessEnvironment()
              ? "In serverless environments the grace cache resets on cold starts — " +
                "consider using TG_LICENSE_KEY for reliable operation. "
              : "") +
            `Verify network connectivity to api.transparentguard.dev. Original error: ${err.message}`,
          "api_unreachable",
        );
      }
      throw err;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tier ordering + minimum feature sets
// ---------------------------------------------------------------------------

/** Numeric rank for tier comparison — higher = more capable. */
export const TIER_RANK: Record<LicenseTier, number> = {
  free: 0, startup: 1, growth: 2, enterprise: 3, oem: 4,
};

/**
 * Canonical minimum feature set for each tier.
 * Used by key-issuance tooling and offline key generation (`tg keys create`).
 * The API may grant additional features on top of these.
 */
export const TIER_MINIMUM_FEATURES: Record<LicenseTier, LicenseFeature[]> = {
  free: [],
  startup: [
    "ml_classifiers", "semantic_targets", "confidentiality_check",
    "compliance_frameworks", "audit_s3", "audit_postgres", "audit_gcs",
    "audit_azure", "audit_chain_integrity", "threshold_notifications",
    "streaming_window", "provider_risk_tier",
  ],
  growth: [
    "ml_classifiers", "semantic_targets", "confidentiality_check",
    "compliance_frameworks", "audit_s3", "audit_postgres", "audit_gcs",
    "audit_azure", "audit_chain_integrity", "threshold_notifications",
    "streaming_window", "provider_risk_tier",
    "policy_registry", "pie",
    "multi_environment", "report_generation", "custom_adapter", "classifier_bundle",
  ],
  enterprise: [
    "ml_classifiers", "semantic_targets", "confidentiality_check",
    "compliance_frameworks", "audit_s3", "audit_postgres", "audit_gcs",
    "audit_azure", "audit_chain_integrity", "threshold_notifications",
    "streaming_window", "provider_risk_tier",
    "policy_registry", "pie",
    "multi_environment", "report_generation", "custom_adapter", "classifier_bundle",
    "fedramp", "trust_chain", "custom_classifier_training",
    "offline_mode", "data_sovereignty", "blocked_training_jurisdictions",
  ],
  oem: [
    "ml_classifiers", "semantic_targets", "confidentiality_check",
    "compliance_frameworks", "audit_s3", "audit_postgres", "audit_gcs",
    "audit_azure", "audit_chain_integrity", "threshold_notifications",
    "streaming_window", "provider_risk_tier",
    "policy_registry", "pie",
    "multi_environment", "report_generation", "custom_adapter", "classifier_bundle",
    "fedramp", "trust_chain", "custom_classifier_training",
    "offline_mode", "data_sovereignty", "blocked_training_jurisdictions",
    "oem_embed",
  ],
};

// ---------------------------------------------------------------------------
// Feature + tier assertion helpers
// ---------------------------------------------------------------------------

/**
 * Asserts that the current license includes the requested feature.
 * Throws TransparentGuardError with code "feature_requires_paid_tier" if not.
 */
export function assertFeature(
  status: LicenseStatus,
  feature: LicenseFeature,
  featureDescription: string,
): void {
  if (!status.features.includes(feature)) {
    throw new TransparentGuardError(
      `${featureDescription} requires a paid TransparentGuard plan. Upgrade at transparentguard.dev.`,
      "feature_requires_paid_tier",
      feature,
    );
  }
}

/**
 * Asserts that the current license tier is at least `required`.
 * Use when a feature is tier-gated rather than feature-flag-gated (e.g. call-volume limits).
 * Throws TransparentGuardError with code "feature_requires_paid_tier" if not.
 */
export function assertTier(
  status: LicenseStatus,
  required: LicenseTier,
  featureDescription: string,
): void {
  if (TIER_RANK[status.tier] < TIER_RANK[required]) {
    throw new TransparentGuardError(
      `${featureDescription} requires a ${required} plan or above. Upgrade at transparentguard.dev.`,
      "feature_requires_paid_tier",
      required,
    );
  }
}
