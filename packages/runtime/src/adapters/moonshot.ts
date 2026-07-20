/**
 * TransparentGuard — Moonshot AI Provider Adapter (Community)
 *
 * Moonshot (Kimi) is OpenAI Chat Completions API-compatible.
 * Covers: moonshot/moonshot-v1-8k, moonshot/moonshot-v1-32k, moonshot/moonshot-v1-128k
 * API spec: https://platform.moonshot.cn/docs/api-reference
 *
 * Note: Moonshot processes data in China (CN).
 */

import type { ProviderAdapter } from "./adapter.js";
import { openAIAdapter } from "./openai.js";
import type { RequestPayload, ResponsePayload } from "../types.js";

export const moonshotAdapter: ProviderAdapter = {
  providerId: "moonshot",
  displayName: "Moonshot AI (Kimi)",
  isOpenAICompat: true,

  auth: {
    headerName: "Authorization",
    headerFormat: "Bearer {key}",
  },

  region: {
    regions: ["cn-beijing"],
    jurisdiction: "CN",
    trainingJurisdiction: "CN",
  },

  capabilities: ["chat", "code", "streaming"],

  normalizeRequest(raw: Record<string, unknown>): RequestPayload {
    const payload = openAIAdapter.normalizeRequest(raw);
    const model = String(raw["model"] ?? "");
    return { ...payload, provider: `moonshot/${model}`, model };
  },

  denormalizeRequest(payload: RequestPayload, original: Record<string, unknown>): Record<string, unknown> {
    return openAIAdapter.denormalizeRequest(payload, original);
  },

  normalizeResponse(raw: Record<string, unknown>, model: string): ResponsePayload {
    const payload = openAIAdapter.normalizeResponse(raw, model);
    return { ...payload, provider: `moonshot/${model}` };
  },

  denormalizeResponse(payload: ResponsePayload, original: Record<string, unknown>): Record<string, unknown> {
    return openAIAdapter.denormalizeResponse(payload, original);
  },
};
