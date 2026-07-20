/**
 * TransparentGuard Runtime — EU Adequacy Decision Table
 *
 * Tracks the European Commission's formal adequacy decisions under GDPR Article 45.
 * An adequacy decision allows personal data to flow from the EU/EEA to a third country
 * without requiring additional safeguards (SCCs, BCRs, etc.).
 *
 * Last updated: 2026-07-17
 * Source: https://ec.europa.eu/info/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en
 *
 * IMPORTANT: This table represents the state of adequacy decisions at the time of
 * this release. Adequacy decisions can be invalidated (e.g. Schrems II invalidated
 * Privacy Shield in 2020). Keep this table updated as Commission decisions change.
 */

export type TransferMechanism =
  | "adequacy_decision"
  | "standard_contractual_clauses"
  | "binding_corporate_rules"
  | "derogation"
  | "none";

export interface AdequacyEntry {
  /** ISO 3166-1 alpha-2 country code */
  jurisdiction: string;
  name: string;
  /**
   * Whether a full adequacy decision is in effect.
   * "conditional" means adequacy applies only to specific sectors or frameworks
   * (e.g. US adequacy only applies to DPF-certified organizations).
   */
  status: "adequate" | "conditional" | "not-adequate";
  /**
   * For "conditional" entries: the qualifying condition.
   */
  condition?: string;
  /** Commission decision reference */
  decision_ref?: string;
  /** ISO-8601 date when the decision was adopted or last renewed */
  decision_date?: string;
  /** ISO-8601 date when the decision expires or is next reviewed, if known */
  review_date?: string;
}

export const ADEQUACY_DECISIONS: AdequacyEntry[] = [
  // ── Full adequacy decisions ─────────────────────────────────────────────
  {
    jurisdiction: "AD", name: "Andorra",
    status: "adequate",
    decision_ref: "2010/625/EU",
    decision_date: "2010-10-19",
  },
  {
    jurisdiction: "AR", name: "Argentina",
    status: "adequate",
    decision_ref: "2003/490/EC",
    decision_date: "2003-06-30",
  },
  {
    jurisdiction: "CA", name: "Canada",
    status: "conditional",
    condition: "Applies only to private-sector organizations subject to PIPEDA. Federal and provincial public-sector data transfers require SCCs.",
    decision_ref: "2002/2/EC",
    decision_date: "2002-01-20",
  },
  {
    jurisdiction: "FO", name: "Faroe Islands",
    status: "adequate",
    decision_ref: "2010/146/EU",
    decision_date: "2010-03-08",
  },
  {
    jurisdiction: "GG", name: "Guernsey",
    status: "adequate",
    decision_ref: "2003/821/EC",
    decision_date: "2003-11-21",
  },
  {
    jurisdiction: "IL", name: "Israel",
    status: "adequate",
    decision_ref: "2011/61/EU",
    decision_date: "2011-01-31",
  },
  {
    jurisdiction: "IM", name: "Isle of Man",
    status: "adequate",
    decision_ref: "2004/411/EC",
    decision_date: "2004-04-28",
  },
  {
    jurisdiction: "JP", name: "Japan",
    status: "adequate",
    decision_ref: "2019/419",
    decision_date: "2019-01-23",
  },
  {
    jurisdiction: "JE", name: "Jersey",
    status: "adequate",
    decision_ref: "2008/393/EC",
    decision_date: "2008-05-08",
  },
  {
    jurisdiction: "NZ", name: "New Zealand",
    status: "adequate",
    decision_ref: "2013/65/EU",
    decision_date: "2013-12-19",
  },
  {
    jurisdiction: "KR", name: "Republic of Korea",
    status: "adequate",
    decision_ref: "2021/C 432/02",
    decision_date: "2021-12-17",
  },
  {
    jurisdiction: "CH", name: "Switzerland",
    status: "adequate",
    decision_ref: "2000/518/EC",
    decision_date: "2000-07-26",
  },
  {
    jurisdiction: "GB", name: "United Kingdom",
    status: "adequate",
    decision_ref: "2021/1772",
    decision_date: "2021-06-28",
    review_date: "2025-06-27",
  },
  {
    jurisdiction: "UY", name: "Uruguay",
    status: "adequate",
    decision_ref: "2012/484/EU",
    decision_date: "2012-08-21",
  },

  // ── Conditional adequacy (sector/framework specific) ─────────────────────
  {
    jurisdiction: "US", name: "United States",
    status: "conditional",
    condition: "Adequacy applies only to organizations certified under the EU-US Data Privacy Framework (DPF). Transfers to non-DPF-certified US organizations require SCCs or BCRs.",
    decision_ref: "2023/1795",
    decision_date: "2023-07-10",
  },

  // ── Jurisdictions with no adequacy decision (not exhaustive) ─────────────
  {
    jurisdiction: "CN", name: "China",
    status: "not-adequate",
  },
  {
    jurisdiction: "RU", name: "Russia",
    status: "not-adequate",
  },
  {
    jurisdiction: "IN", name: "India",
    status: "not-adequate",
  },
  {
    jurisdiction: "BR", name: "Brazil",
    status: "not-adequate",
  },
  {
    jurisdiction: "BY", name: "Belarus",
    status: "not-adequate",
  },
  {
    jurisdiction: "IR", name: "Iran",
    status: "not-adequate",
  },
];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

const ADEQUACY_MAP = new Map<string, AdequacyEntry>(
  ADEQUACY_DECISIONS.map((e) => [e.jurisdiction, e]),
);

/**
 * Returns the adequacy status for a given ISO 3166-1 alpha-2 jurisdiction code.
 * Returns null if the jurisdiction is not in the table (treat as "not-adequate" if fail-closed behavior is required).
 */
export function getAdequacyStatus(jurisdiction: string): AdequacyEntry | null {
  return ADEQUACY_MAP.get(jurisdiction.toUpperCase()) ?? null;
}

/**
 * Returns true if personal data can flow to `jurisdiction` under GDPR Art. 45
 * without additional safeguards (i.e. the jurisdiction has "adequate" status).
 * "conditional" is treated as adequate only when the condition is verified externally.
 */
export function isAdequate(jurisdiction: string, includeConditional = false): boolean {
  const entry = getAdequacyStatus(jurisdiction);
  if (!entry) return false;
  if (entry.status === "adequate") return true;
  if (entry.status === "conditional" && includeConditional) return true;
  return false;
}

/**
 * EU/EEA member states — always adequate for intra-EEA transfers.
 */
export const EU_EEA_JURISDICTIONS = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR",
  "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
  "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  // EEA non-EU
  "IS", "LI", "NO",
  // Included by reference
  "UK", // post-Brexit adequacy decision still in force
]);

export function isInEEA(jurisdiction: string): boolean {
  return EU_EEA_JURISDICTIONS.has(jurisdiction.toUpperCase());
}
