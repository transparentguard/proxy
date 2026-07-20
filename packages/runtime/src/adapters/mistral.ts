/**
 * TransparentGuard — Mistral AI Provider Adapter
 *
 * Mistral is OpenAI Chat Completions API-compatible.
 * Covers: mistral/mistral-large-latest, mistral/mistral-small-latest, etc.
 * API spec: https://docs.mistral.ai/api/
 */

import type { ProviderAdapter } from "./adapter.js";
import { openAIAdapter } from "./openai.js";
import type { RequestPayload, ResponsePayload } from "../types.js";

export const mistralAdapter: ProviderAdapter = {
  providerId: "mistral",
  displayName: "Mistral AI",
  isOpenAICompat: true,

  auth: {
    headerName: "Authorization",
    headerFormat: "Bearer {key}",
  },

  region: {
    // Mistral processes data in France (EU)
    regions: ["eu-west-3", "eu-central-1"],
    jurisdiction: "FR",
    trainingJurisdiction: "FR",
  },

  capabilities: ["chat", "function_calling", "code", "streaming", "embeddings"],

  normalizeRequest(raw: Record<string, unknown>): RequestPayload {
    const payload = openAIAdapter.normalizeRequest(raw);
    const model = String(raw["model"] ?? "");
    return { ...payload, provider: `mistral/${model}`, model };
  },

  denormalizeRequest(payload: RequestPayload, original: Record<string, unknown>): Record<string, unknown> {
    return openAIAdapter.denormalizeRequest(payload, original);
  },

  normalizeResponse(raw: Record<string, unknown>, model: string): ResponsePayload {
    const payload = openAIAdapter.normalizeResponse(raw, model);
    return { ...payload, provider: `mistral/${model}` };
  },

  denormalizeResponse(payload: ResponsePayload, original: Record<string, unknown>): Record<string, unknown> {
    return openAIAdapter.denormalizeResponse(payload, original);
  },
};
