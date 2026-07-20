/**
 * TransparentGuard Runtime — Data Sovereignty Enforcement
 *
 * Full three-jurisdiction data sovereignty model.
 * Replaces the simpler data_residency enforce_type for deployments that need:
 *   1. Data subject jurisdiction inference (WHO the data is about)
 *   2. Processor jurisdiction enforcement (WHERE the AI processes it)
 *   3. Model training jurisdiction enforcement (WHERE the model was trained)
 *   4. Legal transfer mechanism verification (HOW the transfer is lawful)
 *   5. Legal basis tracking (WHY processing is permitted)
 *
 * All five dimensions are emitted in the audit event for regulator-ready trails.
 *
 * Metadata keys read from RequestPayload.metadata:
 *   tg_subject_jurisdiction      ISO 3166-1 alpha-2 — where the data subject is
 *   tg_region / tg_processor_region   cloud region of the AI provider
 *   tg_processor_jurisdiction    ISO 3166-1 alpha-2 — derived from tg_region if absent
 *   tg_x_forwarded_for           IP hint for geo_ip inference
 */

import type {
  EvaluationContext,
  RequestPayload,
  RuleResult,
  Violation,
  DataSubjectJurisdiction,
} from "../types.js";
import { buildAuditEvent } from "../audit/emitter.js";
import { PROVIDER_REGISTRY } from "../registry/provider-registry.js";
import {
  getAdequacyStatus,
  isAdequate,
  isInEEA,
  type TransferMechanism,
} from "../registry/adequacy-decisions.js";

// ---------------------------------------------------------------------------
// Region → jurisdiction mapping (cloud regions → ISO 3166-1)
// ---------------------------------------------------------------------------

const REGION_JURISDICTION_MAP: Record<string, string> = {
  // AWS
  "us-east-1": "US", "us-east-2": "US", "us-west-1": "US", "us-west-2": "US",
  "eu-west-1": "IE", "eu-west-2": "GB", "eu-west-3": "FR",
  "eu-central-1": "DE", "eu-central-2": "CH", "eu-north-1": "SE",
  "eu-south-1": "IT", "eu-south-2": "ES",
  "ap-northeast-1": "JP", "ap-northeast-2": "KR", "ap-northeast-3": "JP",
  "ap-southeast-1": "SG", "ap-southeast-2": "AU",
  "ap-south-1": "IN", "ap-south-2": "IN",
  "ca-central-1": "CA", "ca-west-1": "CA",
  "sa-east-1": "BR",
  "me-south-1": "BH", "me-central-1": "AE",
  "af-south-1": "ZA",
  "cn-north-1": "CN", "cn-northwest-1": "CN",
  // GCP
  "us-central1": "US", "us-east1": "US", "us-east4": "US", "us-east5": "US",
  "us-south1": "US", "us-west1": "US", "us-west2": "US",
  "northamerica-northeast1": "CA", "northamerica-northeast2": "CA",
  "southamerica-east1": "BR", "southamerica-west1": "CL",
  "europe-west1": "BE", "europe-west2": "GB", "europe-west3": "DE",
  "europe-west4": "NL", "europe-west6": "CH", "europe-west8": "IT",
  "europe-west9": "FR", "europe-central2": "PL", "europe-north1": "FI",
  "europe-southwest1": "ES",
  "asia-east1": "TW", "asia-east2": "HK",
  "asia-northeast1": "JP", "asia-northeast2": "JP", "asia-northeast3": "KR",
  "asia-south1": "IN", "asia-south2": "IN",
  "asia-southeast1": "SG", "asia-southeast2": "ID",
  "australia-southeast1": "AU", "australia-southeast2": "AU",
  "me-west1": "IL",
  // Azure
  "eastus": "US", "eastus2": "US", "westus": "US", "westus2": "US", "westus3": "US",
  "centralus": "US", "northcentralus": "US", "southcentralus": "US",
  "westcentralus": "US",
  "northeurope": "IE", "westeurope": "NL",
  "uksouth": "GB", "ukwest": "GB",
  "francecentral": "FR", "francesouth": "FR",
  "germanywestcentral": "DE", "germanynorth": "DE",
  "switzerlandnorth": "CH", "switzerlandwest": "CH",
  "swedencentral": "SE",
  "norwayeast": "NO", "norwaywest": "NO",
  "finlandcentral": "FI",
  "polandcentral": "PL",
  "italynorth": "IT",
  "spaincentral": "ES",
  "eastasia": "HK", "southeastasia": "SG",
  "japaneast": "JP", "japanwest": "JP",
  "koreacentral": "KR", "koreasouth": "KR",
  "australiaeast": "AU", "australiasoutheast": "AU", "australiacentral": "AU",
  "centralindia": "IN", "westindia": "IN", "southindia": "IN",
  "brazilsouth": "BR", "brazilsoutheast": "BR",
  "southafricanorth": "ZA", "southafricawest": "ZA",
  "uaenorth": "AE", "uaecentral": "AE",
  "canadacentral": "CA", "canadaeast": "CA",
  // Special
  "local": "local",
};

function regionToJurisdiction(region: string): string | null {
  return REGION_JURISDICTION_MAP[region] ?? null;
}

// ---------------------------------------------------------------------------
// Subject jurisdiction inference
// ---------------------------------------------------------------------------

/**
 * Infers the data subject's jurisdiction from request metadata.
 * Priority: explicit metadata > geo_ip header hint > config fallback
 */
function inferSubjectJurisdiction(
  config: DataSubjectJurisdiction | undefined,
  meta: Record<string, string>,
): string | null {
  // Explicit metadata always wins
  const explicit = meta["tg_subject_jurisdiction"] ?? meta["x-tg-subject-jurisdiction"];
  if (explicit) return explicit.toUpperCase();

  if (!config) return null;

  // geo_ip: read the forwarded IP and use a coarse jurisdiction map
  // In production this would call the MaxMind GeoLite2 embedded DB.
  // Here we read the hint from metadata (set by the SDK's geo middleware).
  if (config.infer_from === "geo_ip") {
    const geoHint = meta["tg_geo_jurisdiction"] ?? meta["cf-ipcountry"] ?? meta["x-country-code"];
    if (geoHint) return geoHint.toUpperCase();
  }

  if (config.infer_from === "request_header") {
    const hdr = meta["x-tg-subject-jurisdiction"] ?? meta["x-user-jurisdiction"];
    if (hdr) return hdr.toUpperCase();
  }

  if (config.infer_from === "metadata") {
    const m = meta["tg_subject_jurisdiction"];
    if (m) return m.toUpperCase();
  }

  return config.fallback?.toUpperCase() ?? null;
}

// ---------------------------------------------------------------------------
// Transfer mechanism resolution
// ---------------------------------------------------------------------------

function resolveTransferMechanism(
  processorJurisdiction: string,
): TransferMechanism {
  if (isInEEA(processorJurisdiction)) return "adequacy_decision"; // intra-EEA
  const entry = getAdequacyStatus(processorJurisdiction);
  if (!entry) return "none";
  if (entry.status === "adequate") return "adequacy_decision";
  if (entry.status === "conditional") return "adequacy_decision"; // caller must verify condition
  return "none";
}

// ---------------------------------------------------------------------------
// Main enforcer
// ---------------------------------------------------------------------------

export async function enforceDataSovereignty(
  ctx: EvaluationContext,
): Promise<RuleResult> {
  const { rule, payload, policy, stage, requestId, tags } = ctx;
  const ruleId = rule.id;

  const meta = ("metadata" in payload ? (payload as RequestPayload).metadata : undefined) ?? {};
  const provider = "provider" in payload ? (payload as RequestPayload).provider ?? "" : "";

  // ── Processor region / jurisdiction ─────────────────────────────────────
  const processorRegion =
    meta["tg_region"] ??
    meta["tg_processor_region"] ??
    meta["region"] ??
    meta["provider_region"] ??
    null;

  const processorJurisdiction: string =
    meta["tg_processor_jurisdiction"]?.toUpperCase() ??
    (processorRegion ? regionToJurisdiction(processorRegion) ?? "unknown" : "unknown");

  // ── Subject jurisdiction ─────────────────────────────────────────────────
  const subjectJurisdiction = inferSubjectJurisdiction(rule.data_subject_jurisdiction, meta);

  // If accept list is set, subject must be in it (or we can't determine subject — warn)
  const acceptList = rule.data_subject_jurisdiction?.accept;
  if (acceptList?.length && subjectJurisdiction) {
    // Expand "EU" and "EEA" shorthand
    const expandedAccept = new Set<string>();
    for (const j of acceptList) {
      if (j === "EU" || j === "EEA") {
        // Add all EU/EEA members
        expandedAccept.add("EU");
        expandedAccept.add("EEA");
      } else {
        expandedAccept.add(j.toUpperCase());
      }
    }

    // Check subject in accepted list
    const subjectInEEA = isInEEA(subjectJurisdiction);
    const subjectAccepted =
      expandedAccept.has(subjectJurisdiction) ||
      (expandedAccept.has("EU") && subjectInEEA) ||
      (expandedAccept.has("EEA") && subjectInEEA);

    if (!subjectAccepted) {
      // Subject is outside the scoped jurisdictions for this rule — SKIP (not block)
      return {
        ruleId,
        outcome: "skipped",
        auditEvent: buildAuditEvent({
          policy, rule, eventType: "allowed", stage, payload, tags, requestId,
          detail: `data_sovereignty: subject jurisdiction "${subjectJurisdiction}" not in accept list — rule skipped.`,
        }),
      };
    }
  }

  const violations: string[] = [];

  // ── 1. Blocked processor jurisdictions ──────────────────────────────────
  if (rule.blocked_processor_jurisdictions?.length && processorJurisdiction !== "unknown") {
    if (rule.blocked_processor_jurisdictions.includes(processorJurisdiction)) {
      violations.push(
        `Processor jurisdiction "${processorJurisdiction}" is explicitly blocked. ` +
        `Data from subjects in [${subjectJurisdiction ?? "unknown"}] may not be processed in this jurisdiction.`,
      );
    }
  }

  // ── 2. Allowed processor regions ────────────────────────────────────────
  if (!violations.length && rule.allowed_processor_regions?.length && processorRegion) {
    const inAllowedRegion = rule.allowed_processor_regions.some((r) => {
      if (r === processorRegion) return true;
      if (r.endsWith("-*")) return processorRegion.startsWith(r.slice(0, -2));
      if (r.endsWith("*")) return processorRegion.startsWith(r.slice(0, -1));
      return false;
    });
    if (!inAllowedRegion) {
      violations.push(
        `Processor region "${processorRegion}" is not in allowed_processor_regions: ` +
        `[${rule.allowed_processor_regions.join(", ")}].`,
      );
    }
  }

  // ── 3. Blocked training jurisdictions ───────────────────────────────────
  if (!violations.length && rule.blocked_training_jurisdictions?.length && provider) {
    const entry = PROVIDER_REGISTRY.getProvider(provider);
    const trainingJurisdictions = entry?.training_jurisdictions ?? [];
    for (const blocked of rule.blocked_training_jurisdictions) {
      if (trainingJurisdictions.includes(blocked)) {
        violations.push(
          `Provider "${provider}" trained in blocked jurisdiction "${blocked}". ` +
          `Training jurisdictions: [${trainingJurisdictions.join(", ")}].`,
        );
        break;
      }
    }
  }

  // ── 4. Transfer mechanism verification ──────────────────────────────────
  let transferMechanismUsed: TransferMechanism = "none";
  if (!violations.length && rule.transfer_mechanism?.require_one_of?.length && processorJurisdiction !== "unknown") {
    // Intra-EEA is always valid
    if (isInEEA(processorJurisdiction)) {
      transferMechanismUsed = "adequacy_decision";
    } else {
      // Check if the resolved mechanism satisfies the requirement
      const resolved = resolveTransferMechanism(processorJurisdiction);
      // Cast to Set<string> so "none" (a valid TransferMechanism sentinel) can be passed to has()
      const required = new Set<string>(rule.transfer_mechanism.require_one_of);

      if (resolved !== "none" && required.has(resolved)) {
        transferMechanismUsed = resolved;
      } else {
        // Check if SCCs/BCRs are declared in metadata (operator-attested)
        const declaredMechanism = meta["tg_transfer_mechanism"] as TransferMechanism | undefined;
        if (declaredMechanism && declaredMechanism !== "none" && required.has(declaredMechanism)) {
          transferMechanismUsed = declaredMechanism;
        } else {
          const adequacyEntry = getAdequacyStatus(processorJurisdiction);
          violations.push(
            `No valid transfer mechanism for processor jurisdiction "${processorJurisdiction}". ` +
            `Adequacy status: ${adequacyEntry?.status ?? "not in table"}. ` +
            `Required: [${rule.transfer_mechanism.require_one_of.join(", ")}]. ` +
            `Set metadata.tg_transfer_mechanism to "standard_contractual_clauses" or "binding_corporate_rules" ` +
            `to assert an operator-attested mechanism.`,
          );
        }
      }
    }
  }

  // ── Emit result ──────────────────────────────────────────────────────────

  // Build sovereignty-specific audit extensions
  const sovereigntyMeta: Record<string, string> = {
    subject_jurisdiction: subjectJurisdiction ?? "unknown",
    processor_jurisdiction: processorJurisdiction,
    ...(processorRegion ? { processor_region: processorRegion } : {}),
    ...(transferMechanismUsed !== "none" ? { transfer_mechanism_used: transferMechanismUsed } : {}),
    ...(rule.legal_basis ? { legal_basis: rule.legal_basis } : {}),
  };

  if (violations.length === 0) {
    return {
      ruleId,
      outcome: "passed",
      auditEvent: buildAuditEvent({
        policy, rule, eventType: "allowed", stage, payload, tags: { ...tags, ...sovereigntyMeta }, requestId,
      }),
    };
  }

  const detail = violations.join(" | ");
  const outcome = rule.on_violation === "block" ? "blocked" : "warned";

  const violation: Violation = {
    rule_id: ruleId,
    rule_description: rule.description,
    outcome,
    detail,
    category: "data_sovereignty_violation",
  };

  return {
    ruleId,
    outcome,
    violation,
    auditEvent: buildAuditEvent({
      policy, rule,
      eventType: outcome === "blocked" ? "blocked" : "warned",
      stage, payload,
      tags: { ...tags, ...sovereigntyMeta },
      requestId,
      detail,
    }),
  };
}
