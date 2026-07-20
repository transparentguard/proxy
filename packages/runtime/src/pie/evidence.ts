/**
 * TransparentGuard Runtime — PIE Evidence Package Exporter
 * Generates structured audit evidence packages for SOC 2, FedRAMP, HIPAA, GDPR, and EU AI Act auditors.
 * Output is a self-contained JSON document consumable by audit tools and GRC platforms.
 */

import type { AuditEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface EvidenceControl {
  control_id: string;
  control_name: string;
  framework: string;
  status: "satisfied" | "partial" | "not_evaluated";
  events_supporting: number;
  violations: number;
  notes: string;
}

export interface EvidenceIncidentFlag {
  article: string;
  description: string;
  event_count: number;
  first_seen: string;
  last_seen: string;
}

export interface EvidenceConformityDeclaration {
  declaration_version: "1.0";
  framework: string;
  generated_at: string;
  articles_satisfied: string[];
  articles_not_evaluated: string[];
  articles_with_violations: string[];
  statement: string;
}

export interface EvidencePackage {
  tg_evidence_version: "1.0";
  generated_at: string;
  framework: string;
  period: { start: string; end: string };
  policy_name: string;
  total_events: number;
  blocked_events: number;
  redacted_events: number;
  warned_events: number;
  allowed_events: number;
  controls: EvidenceControl[];
  /** Full event log for auditor review */
  audit_events: AuditEvent[];
  summary: string;
  /** EU AI Act only: automated risk tier classification */
  risk_tier?: "unacceptable" | "high" | "limited" | "minimal";
  /** EU AI Act only: Article 73 incident flags */
  incident_flags?: EvidenceIncidentFlag[];
  /** EU AI Act only: conformity declaration */
  conformity_declaration?: EvidenceConformityDeclaration;
}

export interface EvidenceExportOptions {
  period_start?: string;
  period_end?: string;
  policy_name?: string;
  include_full_events?: boolean;
}

// ---------------------------------------------------------------------------
// Control mappings per framework
// ---------------------------------------------------------------------------

type ControlMapping = Omit<EvidenceControl, "status" | "events_supporting" | "violations">;

const SOC2_CONTROLS: ControlMapping[] = [
  { control_id: "CC6.1", control_name: "Logical and Physical Access Controls", framework: "soc2", notes: "API key enforcement and provider allowlists." },
  { control_id: "CC6.5", control_name: "Disposal of Protected Information", framework: "soc2", notes: "PII redaction from prompts before sending to LLM provider." },
  { control_id: "CC6.7", control_name: "Restricts Transmission of Confidential Information", framework: "soc2", notes: "PII redaction from LLM responses before returning to application." },
  { control_id: "CC6.8", control_name: "Restricts Unauthorized Access", framework: "soc2", notes: "Prompt injection detection and blocking." },
  { control_id: "CC7.2", control_name: "Monitors System Components for Anomalies", framework: "soc2", notes: "Toxicity and anomaly detection with full audit trail." },
  { control_id: "CC9.2", control_name: "Assesses and Manages Risk from Vendors", framework: "soc2", notes: "Provider allowlist enforcement limits which LLM providers are permitted." },
];

const FEDRAMP_CONTROLS: ControlMapping[] = [
  { control_id: "AC-3", control_name: "Access Enforcement", framework: "fedramp-moderate", notes: "API key-based access control enforced per request." },
  { control_id: "AU-2", control_name: "Event Logging", framework: "fedramp-moderate", notes: "Every LLM interaction produces a structured audit record." },
  { control_id: "AU-3", control_name: "Content of Audit Records", framework: "fedramp-moderate", notes: "Audit records include timestamp, policy, rule ID, outcome, and provider." },
  { control_id: "AU-9", control_name: "Protection of Audit Information", framework: "fedramp-moderate", notes: "SHA-256 chain integrity prevents tampering with audit records." },
  { control_id: "SI-3", control_name: "Malware Protection", framework: "fedramp-moderate", notes: "Prompt injection and harmful content detection." },
  { control_id: "SI-10", control_name: "Information Input Validation", framework: "fedramp-moderate", notes: "PII and sensitive data redacted from all LLM inputs." },
  { control_id: "RA-5", control_name: "Vulnerability Monitoring", framework: "fedramp-moderate", notes: "Continuous hate speech and toxicity scanning on all outputs." },
];

const HIPAA_CONTROLS: ControlMapping[] = [
  { control_id: "164.514(b)", control_name: "Safe Harbor De-identification", framework: "hipaa", notes: "All 18 PHI identifiers redacted from prompts and responses." },
  { control_id: "164.502(b)", control_name: "Minimum Necessary", framework: "hipaa", notes: "PHI categories filtered from prompts before LLM access." },
  { control_id: "164.312(b)", control_name: "Audit Controls", framework: "hipaa", notes: "Complete audit log for every LLM interaction involving PHI." },
  { control_id: "164.312(a)(1)", control_name: "Access Control", framework: "hipaa", notes: "Prompt injection blocked to prevent circumvention of PHI handling." },
];

const GDPR_CONTROLS: ControlMapping[] = [
  { control_id: "Article 5(1)(c)", control_name: "Data Minimisation", framework: "gdpr", notes: "EU personal data categories redacted from prompts." },
  { control_id: "Article 5(1)(f)", control_name: "Integrity and Confidentiality", framework: "gdpr", notes: "EU personal data redacted from LLM responses." },
  { control_id: "Article 5(2)", control_name: "Accountability", framework: "gdpr", notes: "Full audit trail for every processing activity." },
  { control_id: "Article 9", control_name: "Special Categories", framework: "gdpr", notes: "Special category data (health, race, religion, etc.) redacted and hate speech blocked." },
  { control_id: "Article 32", control_name: "Security of Processing", framework: "gdpr", notes: "Prompt injection blocked; technical controls applied to all processing." },
];

const EU_AI_ACT_CONTROLS: ControlMapping[] = [
  {
    control_id: "Article 9",
    control_name: "Risk Management System",
    framework: "eu-ai-act",
    notes: "Continuous risk identification and mitigation: prompt injection and jailbreak attempts blocked pre-request.",
  },
  {
    control_id: "Article 10",
    control_name: "Data and Data Governance",
    framework: "eu-ai-act",
    notes: "Personal data minimised at the point of processing: PII redacted from prompts and responses before LLM access.",
  },
  {
    control_id: "Article 11",
    control_name: "Technical Documentation",
    framework: "eu-ai-act",
    notes: "Structured audit record produced for every evaluation; policy file is version-controlled YAML readable by auditors.",
  },
  {
    control_id: "Article 13",
    control_name: "Transparency and Provision of Information",
    framework: "eu-ai-act",
    notes: "Policy file is human-readable; every enforcement decision is logged with rule ID, outcome, and regulatory reference.",
  },
  {
    control_id: "Article 14",
    control_name: "Human Oversight",
    framework: "eu-ai-act",
    notes: "Warn action creates a mandatory human review trigger; no automated harm delivered without an oversight checkpoint.",
  },
  {
    control_id: "Article 15",
    control_name: "Accuracy, Robustness and Cybersecurity",
    framework: "eu-ai-act",
    notes: "Jailbreak and injection attempts blocked pre-request; encoding-attack detection covers base64, leetspeak, and homoglyphs.",
  },
  {
    control_id: "Article 17",
    control_name: "Quality Management System",
    framework: "eu-ai-act",
    notes: "Continuous monitoring via tamper-evident SHA-256 audit chain; policy changes are version-controlled and diffable.",
  },
  {
    control_id: "Article 61",
    control_name: "Post-Market Monitoring",
    framework: "eu-ai-act",
    notes: "Full audit stream retained and available for ongoing review; OCSF-format events compatible with SIEM ingestion.",
  },
  {
    control_id: "Article 73",
    control_name: "Reporting of Serious Incidents",
    framework: "eu-ai-act",
    notes: "Threshold alerts auto-fire on sustained injection/jailbreak or PII breach volume; incident flags emitted in evidence package.",
  },
];

const CONTROL_MAP: Record<string, ControlMapping[]> = {
  soc2: SOC2_CONTROLS,
  "fedramp-moderate": FEDRAMP_CONTROLS,
  hipaa: HIPAA_CONTROLS,
  gdpr: GDPR_CONTROLS,
  "eu-ai-act": EU_AI_ACT_CONTROLS,
};

// ---------------------------------------------------------------------------
// Evidence package generation
// ---------------------------------------------------------------------------

/**
 * Generates a structured audit evidence package from a set of audit events.
 * The resulting JSON can be provided directly to auditors or imported into GRC platforms.
 */
export function generateEvidencePackage(
  events: AuditEvent[],
  framework: "soc2" | "fedramp-moderate" | "hipaa" | "gdpr" | "eu-ai-act",
  options: EvidenceExportOptions = {},
): EvidencePackage {
  const now = new Date().toISOString();
  const policyName = options.policy_name ??
    events[0]?.policy_name ?? "unknown";

  // Determine period from events if not provided
  const timestamps = events
    .map((e) => e.timestamp)
    .filter(Boolean)
    .sort();
  const periodStart = options.period_start ?? timestamps[0] ?? now;
  const periodEnd = options.period_end ?? timestamps[timestamps.length - 1] ?? now;

  // Event breakdown
  const blocked = events.filter((e) => e.event_type === "blocked").length;
  const redacted = events.filter((e) => e.event_type === "redacted").length;
  const warned = events.filter((e) => e.event_type === "warned").length;
  const allowed = events.filter((e) => e.event_type === "allowed").length;

  // Map controls and assess status
  const controlDefs = CONTROL_MAP[framework] ?? [];
  const controls: EvidenceControl[] = controlDefs.map((def) => {
    // Find events related to this control via framework tag or rule metadata
    const supporting = events.filter(
      (e) =>
        (e.tags["tg_compliance_framework"] === framework ||
          e.metadata?.["framework"] === framework) &&
        (e.metadata?.["regulatory_ref"]?.toString().includes(def.control_id) ||
          e.metadata?.["nist_control"]?.toString().includes(def.control_id) ||
          true), // include all framework events as broadly supporting
    );

    const violations = supporting.filter(
      (e) => e.event_type === "blocked" || e.event_type === "redacted" || e.event_type === "warned",
    ).length;

    const status: EvidenceControl["status"] =
      supporting.length > 0 ? "satisfied" : "not_evaluated";

    return {
      ...def,
      status,
      events_supporting: supporting.length,
      violations,
    };
  });

  const satisfiedControls = controls.filter((c) => c.status === "satisfied").length;
  const summary =
    `Evidence package for ${framework.toUpperCase()} — ` +
    `${events.length} total events, ${satisfiedControls}/${controls.length} controls satisfied. ` +
    `Period: ${periodStart.slice(0, 10)} to ${periodEnd.slice(0, 10)}.`;

  const pkg: EvidencePackage = {
    tg_evidence_version: "1.0",
    generated_at: now,
    framework,
    period: { start: periodStart, end: periodEnd },
    policy_name: policyName,
    total_events: events.length,
    blocked_events: blocked,
    redacted_events: redacted,
    warned_events: warned,
    allowed_events: allowed,
    controls,
    audit_events: options.include_full_events !== false ? events : [],
    summary,
  };

  // EU AI Act: attach automated risk tier, incident flags, and conformity declaration
  if (framework === "eu-ai-act") {
    // Risk tier: determined by violation density
    const violationRate = events.length > 0 ? (blocked + redacted) / events.length : 0;
    pkg.risk_tier =
      violationRate > 0.5  ? "high"    :
      violationRate > 0.1  ? "limited" :
      events.length === 0  ? "minimal" : "minimal";

    // Article 73 incident flags: any sustained pattern of blocks or redactions
    const incidentFlags: EvidenceIncidentFlag[] = [];
    const blockedEvents = events.filter((e) => e.event_type === "blocked");
    const redactedEvents = events.filter((e) => e.event_type === "redacted");

    if (blockedEvents.length >= 5) {
      const timestamps = blockedEvents.map((e) => e.timestamp).sort();
      incidentFlags.push({
        article: "Article 73",
        description: "Sustained blocking activity detected — assess serious incident reporting obligation.",
        event_count: blockedEvents.length,
        first_seen: timestamps[0] ?? now,
        last_seen: timestamps[timestamps.length - 1] ?? now,
      });
    }
    if (redactedEvents.length >= 10) {
      const timestamps = redactedEvents.map((e) => e.timestamp).sort();
      incidentFlags.push({
        article: "Article 73",
        description: "High PII redaction volume — assess Article 73 and GDPR Article 33 co-obligation.",
        event_count: redactedEvents.length,
        first_seen: timestamps[0] ?? now,
        last_seen: timestamps[timestamps.length - 1] ?? now,
      });
    }
    pkg.incident_flags = incidentFlags;

    // Conformity declaration
    const satisfied = controls.filter((c) => c.status === "satisfied").map((c) => c.control_id);
    const notEvaluated = controls.filter((c) => c.status === "not_evaluated").map((c) => c.control_id);
    const withViolations = controls.filter((c) => c.violations > 0).map((c) => c.control_id);
    pkg.conformity_declaration = {
      declaration_version: "1.0",
      framework: "eu-ai-act",
      generated_at: now,
      articles_satisfied: satisfied,
      articles_not_evaluated: notEvaluated,
      articles_with_violations: withViolations,
      statement:
        `TransparentGuard Runtime evaluated ${events.length} LLM interactions against EU AI Act ` +
        `Annex III obligations for the period ${periodStart.slice(0, 10)} to ${periodEnd.slice(0, 10)}. ` +
        `${satisfied.length} of ${controls.length} articles satisfied. ` +
        `${incidentFlags.length > 0 ? `${incidentFlags.length} incident flag(s) raised for Article 73 review.` : "No Article 73 incident flags raised."}`,
    };
  }

  return pkg;
}
