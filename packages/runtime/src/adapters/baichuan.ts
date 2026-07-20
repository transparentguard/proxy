/**
 * TransparentGuard — Baichuan AI Provider Adapter (Community)
 *
 * Baichuan uses an OpenAI-compatible Chat Completions API.
 * Covers: baichuan/Baichuan4, baichuan/Baichuan3-Turbo, baichuan/Baichuan3-Turbo-128k
 * API spec: https://platform.baichuan-ai.com/docs/api
 *
 * Note: Baichuan AI processes data in China (CN).
 */

import type { ProviderAdapter } from "./adapter.js";
import { openAIAdapter } from "./openai.js";
import type { RequestPayload, ResponsePayload } from "../types.js";

export const baichuanAdapter: ProviderAdapter = {
  providerId: "baichuan",
  displayName: "Baichuan AI",
  isOpenAICompat: true,

  auth: {
    headerName: "Authorization",
    headerFormat: "Bearer {key}",
  },

  region: {
    regions: ["cn-shenzhen"],
    jurisdiction: "CN",
    trainingJurisdiction: "CN",
  },

  capabilities: ["chat", "streaming"],

  normalizeRequest(raw: Record<string, unknown>): RequestPayload {
    const payload = openAIAdapter.normalizeRequest(raw);
    const model = String(raw["model"] ?? "");
    return { ...payload, provider: `baichuan/${model}`, model };
  },

  denormalizeRequest(payload: RequestPayload, original: Record<string, unknown>): Record<string, unknown> {
    return openAIAdapter.denormalizeRequest(payload, original);
  },

  normalizeResponse(raw: Record<string, unknown>, model: string): ResponsePayload {
    const payload = openAIAdapter.normalizeResponse(raw, model);
    return { ...payload, provider: `baichuan/${model}` };
  },

  denormalizeResponse(payload: ResponsePayload, original: Record<string, unknown>): Record<string, unknown> {
    return openAIAdapter.denormalizeResponse(payload, original);
  },
};
