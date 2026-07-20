/**
 * TransparentGuard — Groq Provider Adapter
 *
 * Groq is OpenAI Chat Completions API-compatible.
 * Covers: groq/llama-3.1-70b-versatile, groq/mixtral-8x7b-32768, etc.
 * API spec: https://console.groq.com/docs/openai
 */

import type { ProviderAdapter } from "./adapter.js";
import { openAIAdapter } from "./openai.js";
import type { RequestPayload, ResponsePayload } from "../types.js";

export const groqAdapter: ProviderAdapter = {
  providerId: "groq",
  displayName: "Groq",
  isOpenAICompat: true,

  auth: {
    headerName: "Authorization",
    headerFormat: "Bearer {key}",
  },

  region: {
    regions: ["us-east-1", "us-west-2"],
    jurisdiction: "US",
    trainingJurisdiction: "US",
  },

  capabilities: ["chat", "function_calling", "code", "streaming"],

  normalizeRequest(raw: Record<string, unknown>): RequestPayload {
    const payload = openAIAdapter.normalizeRequest(raw);
    const model = String(raw["model"] ?? "");
    return { ...payload, provider: `groq/${model}`, model };
  },

  denormalizeRequest(payload: RequestPayload, original: Record<string, unknown>): Record<string, unknown> {
    return openAIAdapter.denormalizeRequest(payload, original);
  },

  normalizeResponse(raw: Record<string, unknown>, model: string): ResponsePayload {
    const payload = openAIAdapter.normalizeResponse(raw, model);
    return { ...payload, provider: `groq/${model}` };
  },

  denormalizeResponse(payload: ResponsePayload, original: Record<string, unknown>): Record<string, unknown> {
    return openAIAdapter.denormalizeResponse(payload, original);
  },
};
