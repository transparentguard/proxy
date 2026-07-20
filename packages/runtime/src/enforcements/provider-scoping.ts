/**
 * TransparentGuard Runtime — Rule-Level Provider Scoping
 *
 * Three-tier provider matching applied before any rule evaluator runs.
 * A "no-match" SKIPS the rule (does not block the call) — this is distinct
 * from enforce_type:provider_allowlist, which BLOCKS calls to non-allowed providers.
 *
 * Tier 1 — providers[]           : glob matching against provider/model identifier
 * Tier 2 — provider_match        : capability, risk-tier, context window, training cutoff
 * Tier 3 — provider_match (deep) : attestation requirements, signed-response gate
 *
 * Provider data is resolved from the embedded TG Provider Registry
 * (registry/provider-registry.json), which ships with the runtime and is
 * refreshed via the TG registry endpoint on a configurable TTL.
 */

import type { EvaluationContext, ProviderCapabilityMatch } from "../types.js";
import { PROVIDER_REGISTRY } from "../registry/provider-registry.js";

// ---------------------------------------------------------------------------
// Tier 1 — Glob matching
// ---------------------------------------------------------------------------

/**
 * Matches an actual provider string against a scope entry.
 * Supports:
 *   "openai/gpt-4o"          exact match
 *   "openai/*"               any model from openai
 *   "hf/meta-llama/*"        any HF-hosted Meta Llama model
 *   "!deepseek/*"            negation — never match deepseek (prefix !)
 */
export function matchesProviderGlob(actual: string, pattern: string): boolean {
  if (pattern.startsWith("!")) return false; // negations handled separately
  if (pattern === "any") return true;
  if (pattern === actual) return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    return actual === prefix || actual.startsWith(`${prefix}/`);
  }
  if (pattern.endsWith("-*")) {
    const prefix = pattern.slice(0, -2);
    return actual.startsWith(prefix);
  }
  return false;
}

/**
 * Evaluates the full providers[] list against the actual provider.
 * Negation entries (starting with "!") are checked first — any match short-circuits to false.
 */
function matchesTier1(actual: string, providerScope: string[]): boolean {
  // Check negations first
  const negations = providerScope.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  for (const neg of negations) {
    if (matchesProviderGlob(actual, neg)) return false;
  }
  // Positive patterns
  const positives = providerScope.filter((p) => !p.startsWith("!"));
  if (positives.length === 0) return true; // only negations — anything not negated passes
  return positives.some((p) => matchesProviderGlob(actual, p));
}

// ---------------------------------------------------------------------------
// Tier 2 — Capability / risk-tier / cutoff matching
// ---------------------------------------------------------------------------

function matchesTier2(actual: string, match: ProviderCapabilityMatch): boolean {
  const entry = PROVIDER_REGISTRY.getProvider(actual);

  // Explicit exclusion list
  if (match.excludes?.length) {
    for (const excl of match.excludes) {
      if (matchesProviderGlob(actual, excl)) return false;
    }
  }

  // Blocked training jurisdictions
  if (match.blocked_training_jurisdictions?.length && entry) {
    const trainingJurisdictions = entry.training_jurisdictions ?? [];
    for (const blocked of match.blocked_training_jurisdictions) {
      if (trainingJurisdictions.includes(blocked)) return false;
    }
  }

  // Capability requirements
  if (match.capabilities?.length && entry) {
    const providerCaps = entry.capabilities ?? [];
    const hasAll = match.capabilities.every((cap) => providerCaps.includes(cap));
    if (!hasAll) return false;
  }

  // Risk tier
  if (match.risk_tier?.length && entry) {
    if (!match.risk_tier.includes(entry.risk_tier ?? "medium")) return false;
  }

  // Minimum context window
  if (match.min_context_window != null && entry) {
    if ((entry.max_context_window ?? 0) < match.min_context_window) return false;
  }

  // Training cutoff
  if (match.training_cutoff_after && entry) {
    const cutoff = entry.training_cutoff;
    if (!cutoff) return false; // unknown cutoff — fail closed
    if (cutoff < match.training_cutoff_after) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Tier 3 — Attestation / signed-response gating
// ---------------------------------------------------------------------------

function matchesTier3(actual: string, match: ProviderCapabilityMatch): boolean {
  if (!match.requires_attestation?.length && !match.requires_signed_response) return true;

  const entry = PROVIDER_REGISTRY.getProvider(actual);
  if (!entry) return false; // unknown provider — fail closed when attestation required

  // Attestation requirements
  if (match.requires_attestation?.length) {
    const providerAttestations = new Set(entry.attestations ?? []);
    const hasAll = match.requires_attestation.every((a) => providerAttestations.has(a));
    if (!hasAll) return false;
  }

  // Signed response requirement
  if (match.requires_signed_response && !entry.supports_signed_responses) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when a rule should be evaluated for the current request's provider.
 * Returns false when the rule should be SKIPPED.
 *
 * If neither rule.providers nor rule.provider_match is set, always returns true.
 */
export function providerMatchesRuleScope(
  rule: { providers?: string[]; provider_match?: ProviderCapabilityMatch },
  ctx: EvaluationContext,
): boolean {
  const actual =
    "provider" in ctx.payload ? (ctx.payload.provider ?? "") : "";

  // No provider scoping on this rule — always evaluate
  if (!rule.providers?.length && !rule.provider_match) return true;

  // Empty string provider — cannot scope; evaluate (fail-open for unscoped rules)
  if (!actual) return true;

  // Tier 1 — glob list
  if (rule.providers?.length) {
    if (!matchesTier1(actual, rule.providers)) return false;
  }

  // Tiers 2 + 3 — capability / attestation
  if (rule.provider_match) {
    if (!matchesTier2(actual, rule.provider_match)) return false;
    if (!matchesTier3(actual, rule.provider_match)) return false;
  }

  return true;
}
