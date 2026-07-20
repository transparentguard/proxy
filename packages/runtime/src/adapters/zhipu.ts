/**
 * TransparentGuard — Zhipu AI Provider Adapter (Community)
 *
 * Zhipu AI (GLM) uses an OpenAI-compatible API.
 * Covers: zhipu/glm-4, zhipu/glm-4v, zhipu/glm-3-turbo
 * API spec: https://open.bigmodel.cn/dev/api
 *
 * Note: Zhipu AI processes data in China (CN).
 * Auth uses JWT tokens generated from the API key; the headerFormat
 * carries the pre-signed JWT — the proxy layer generates the JWT before injection.
 */

import type { ProviderAdapter } from "./adapter.js";
import { openAIAdapter } from "./openai.js";
import type { RequestPayload, ResponsePayload } from "../types.js";

export const zhipuAdapter: ProviderAdapter = {
  providerId: "zhipu",
  displayName: "Zhipu AI (GLM)",
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

  capabilities: ["chat", "function_calling", "vision", "code", "streaming", "embeddings"],

  normalizeRequest(raw: Record<string, unknown>): RequestPayload {
    const payload = openAIAdapter.normalizeRequest(raw);
    const model = String(raw["model"] ?? "");
    return { ...payload, provider: `zhipu/${model}`, model };
  },

  denormalizeRequest(payload: RequestPayload, original: Record<string, unknown>): Record<string, unknown> {
    return openAIAdapter.denormalizeRequest(payload, original);
  },

  normalizeResponse(raw: Record<string, unknown>, model: string): ResponsePayload {
    const payload = openAIAdapter.normalizeResponse(raw, model);
    return { ...payload, provider: `zhipu/${model}` };
  },

  denormalizeResponse(payload: ResponsePayload, original: Record<string, unknown>): Record<string, unknown> {
    return openAIAdapter.denormalizeResponse(payload, original);
  },
};
