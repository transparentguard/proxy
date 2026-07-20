/**
 * TransparentGuard Runtime — S3 Audit Destination
 *
 * Uploads audit events to Amazon S3 (or any S3-compatible endpoint).
 * Uses batched PutObject calls keyed by timestamp for Athena/Glue compatibility.
 *
 * On first write, enforces a lifecycle policy on the bucket:
 *   - Transition to STANDARD_IA at 90 days
 *   - Transition to GLACIER at 365 days
 *   - Expire (delete) at 2555 days (7 years — HIPAA 164.530(j) compliant)
 *
 * The retention_days option overrides the default 2555-day expiry.
 *
 * Requirements:
 *   npm install @aws-sdk/client-s3 @aws-sdk/client-s3-control
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION (standard AWS SDK env vars)
 *
 * URI format: s3://bucket-name/optional/prefix/
 */

import type { AuditEvent } from "../../types.js";
import { AuditEmitter } from "../emitter.js";

// ---------------------------------------------------------------------------
// Minimal inline types — avoids importing AWS SDKs at type-check time.
// The actual implementation loads the SDK dynamically at runtime.
// ---------------------------------------------------------------------------

interface S3ClientConfig {
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

interface PutObjectInput {
  Bucket: string;
  Key: string;
  Body: string;
  ContentType: string;
}

interface LifecycleRule {
  ID: string;
  Status: "Enabled" | "Disabled";
  Filter: { Prefix: string };
  Transitions: Array<{ Days: number; StorageClass: string }>;
  Expiration: { Days: number };
}

interface PutBucketLifecycleConfigurationInput {
  Bucket: string;
  LifecycleConfiguration: { Rules: LifecycleRule[] };
}

interface GetBucketLifecycleConfigurationInput {
  Bucket: string;
}

interface S3Sdk {
  S3Client: new (config: S3ClientConfig) => { send(cmd: unknown): Promise<unknown> };
  PutObjectCommand: new (input: PutObjectInput) => unknown;
  PutBucketLifecycleConfigurationCommand: new (input: PutBucketLifecycleConfigurationInput) => unknown;
  GetBucketLifecycleConfigurationCommand: new (input: GetBucketLifecycleConfigurationInput) => unknown;
}

function loadSdk(): S3Sdk {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@aws-sdk/client-s3") as S3Sdk;
  } catch {
    throw new Error(
      "[TransparentGuard] @aws-sdk/client-s3 is required for S3 audit destinations.\n" +
      "Install it: npm install @aws-sdk/client-s3",
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseS3Uri(uri: string): { bucket: string; prefix: string } {
  const withoutScheme = uri.slice("s3://".length);
  const slashIdx = withoutScheme.indexOf("/");
  if (slashIdx === -1) {
    return { bucket: withoutScheme, prefix: "" };
  }
  const bucket = withoutScheme.slice(0, slashIdx);
  let prefix = withoutScheme.slice(slashIdx + 1);
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  return { bucket, prefix };
}

function buildS3Key(prefix: string, batchId: string): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  return `${prefix}${yyyy}/${mm}/${dd}/${hh}/tg-audit-${batchId}.jsonl`;
}

// ---------------------------------------------------------------------------
// Lifecycle policy enforcement
// ---------------------------------------------------------------------------

const LIFECYCLE_RULE_ID = "transparentguard-audit-retention";

/**
 * Applies a retention lifecycle policy to the audit bucket.
 * Runs once per destination instance; safe to call on every first write.
 *
 * Transition schedule (HIPAA-compliant default: 2555 days = 7 years):
 *   0 days    → STANDARD (hot)
 *   90 days   → STANDARD_IA (infrequent access, ~40% cost reduction)
 *   365 days  → GLACIER (archival, ~80% cost reduction)
 *   retentionDays → DELETE (hard expiry, satisfies HIPAA 164.530(j))
 */
async function applyRetentionLifecycle(
  client: { send(cmd: unknown): Promise<unknown> },
  sdk: S3Sdk,
  bucket: string,
  prefix: string,
  retentionDays: number,
): Promise<void> {
  // Check whether our rule is already present and up-to-date
  try {
    const existing = await client.send(
      new sdk.GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    ) as { Rules?: LifecycleRule[] };

    const existingRule = existing.Rules?.find((r) => r.ID === LIFECYCLE_RULE_ID);
    if (existingRule?.Expiration?.Days === retentionDays) {
      // Already configured with correct expiry — nothing to do
      return;
    }
  } catch (err: unknown) {
    // NoSuchLifecycleConfiguration is expected on first run — continue
    const code = (err as { Code?: string; name?: string }).Code ?? (err as { name?: string }).name;
    if (code !== "NoSuchLifecycleConfiguration") {
      console.warn(`[TransparentGuard] Could not read bucket lifecycle (${String(code)}). Attempting to set lifecycle policy anyway.`);
    }
  }

  const rule: LifecycleRule = {
    ID: LIFECYCLE_RULE_ID,
    Status: "Enabled",
    Filter: { Prefix: prefix },
    Transitions: [
      { Days: 90,  StorageClass: "STANDARD_IA" },
      { Days: 365, StorageClass: "GLACIER" },
    ],
    Expiration: { Days: retentionDays },
  };

  // Merge with existing rules so we don't clobber customer rules
  let existingRules: LifecycleRule[] = [];
  try {
    const current = await client.send(
      new sdk.GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    ) as { Rules?: LifecycleRule[] };
    existingRules = (current.Rules ?? []).filter((r) => r.ID !== LIFECYCLE_RULE_ID);
  } catch {
    // No existing config — start fresh
  }

  await client.send(
    new sdk.PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: {
        Rules: [...existingRules, rule],
      },
    }),
  );

  console.log(
    `[TransparentGuard] S3 lifecycle policy applied to s3://${bucket}/${prefix} — ` +
    `90d→STANDARD_IA, 365d→GLACIER, ${retentionDays}d→EXPIRE.`,
  );
}

// ---------------------------------------------------------------------------
// S3 Destination
// ---------------------------------------------------------------------------

export class S3Destination {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly region: string | undefined;
  private readonly endpoint: string | undefined;
  private readonly retentionDays: number;
  private sdk: S3Sdk | null = null;
  private lifecycleApplied = false;
  private lifecyclePending: Promise<void> | null = null;

  constructor(s3Uri: string, retentionDays = 2555) {
    const { bucket, prefix } = parseS3Uri(s3Uri);
    this.bucket = bucket;
    this.prefix = prefix;
    this.region = process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"];
    this.endpoint = process.env["AWS_S3_ENDPOINT"];
    // Clamp to a minimum of 365 days to prevent accidental data loss
    this.retentionDays = Math.max(365, retentionDays);
  }

  private getSdk(): S3Sdk {
    if (!this.sdk) this.sdk = loadSdk();
    return this.sdk;
  }

  private getClient(): { send(cmd: unknown): Promise<unknown> } {
    const { S3Client } = this.getSdk();
    return new S3Client({
      region: this.region,
      ...(this.endpoint ? { endpoint: this.endpoint, forcePathStyle: true } : {}),
    });
  }

  /**
   * Ensures lifecycle policy is applied before the first write.
   * Subsequent writes skip this check (lifecycleApplied flag).
   */
  private async ensureLifecycle(client: { send(cmd: unknown): Promise<unknown> }): Promise<void> {
    if (this.lifecycleApplied) return;

    // Deduplicate concurrent calls during startup
    if (this.lifecyclePending) {
      await this.lifecyclePending;
      return;
    }

    this.lifecyclePending = applyRetentionLifecycle(
      client,
      this.getSdk(),
      this.bucket,
      this.prefix,
      this.retentionDays,
    ).then(() => {
      this.lifecycleApplied = true;
      this.lifecyclePending = null;
    }).catch((err) => {
      this.lifecyclePending = null;
      // Non-fatal — log and continue. Audit writes must not fail because of lifecycle errors.
      console.warn(
        `[TransparentGuard] Failed to apply S3 lifecycle policy to s3://${this.bucket}/${this.prefix}: ${String(err)}. ` +
        `Audit writes will continue. Manually configure lifecycle policy to ensure ${this.retentionDays}-day retention.`,
      );
    });

    await this.lifecyclePending;
  }

  async write(events: AuditEvent[], format: "ndjson" | "json" | "ocsf"): Promise<void> {
    if (events.length === 0) return;

    const client = this.getClient();

    // Apply lifecycle policy on first write
    await this.ensureLifecycle(client);

    const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const key = buildS3Key(this.prefix, batchId);
    const body = AuditEmitter.serialize(events, format);
    const contentType =
      format === "ocsf" || format === "ndjson"
        ? "application/x-ndjson"
        : "application/json";

    await client.send(
      new (this.getSdk()).PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async flush(): Promise<void> {
    // S3 writes are one-shot in write() — nothing to flush
  }
}
