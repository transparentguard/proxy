/**
 * TransparentGuard — vLLM Provider Adapter
 *
 * vLLM serves an OpenAI-compatible API for self-hosted open-source models.
 * Covers: vllm/llama-3-70b-instruct, vllm/mistral-7b-v0.3, etc.
 * API spec: https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html
 *
 * Region/jurisdiction fields reflect self-hosted deployments (operator-defined).
 * The proxy layer should override these at runtime when the deployment region is known.
 */

import type { ProviderAdapter } from "./adapter.js";
import { openAIAdapter } from "./openai.js";
import type { RequestPayload, ResponsePayload } from "../types.js";

export const vllmAdapter: ProviderAdapter = {
  providerId: "vllm",
  displayName: "vLLM (self-hosted)",
  isOpenAICompat: true,

  auth: {
    headerName: "Authorization",
    // vLLM accepts any bearer token when auth is enabled; token is often "EMPTY"
    headerFormat: "Bearer {key}",
  },

  region: {
    // Self-hosted: operator-defined. We use a sentinel value here.
    // The data_sovereignty enforcer skips jurisdiction checks when jurisdiction is "self-hosted".
    regions: ["self-hosted"],
    jurisdiction: "self-hosted",
    trainingJurisdiction: "self-hosted",
  },

  capabilities: ["chat", "function_calling", "code", "streaming", "embeddings"],

  normalizeRequest(raw: Record<string, unknown>): RequestPayload {
    const payload = openAIAdapter.normalizeRequest(raw);
    const model = String(raw["model"] ?? "");
    return { ...payload, provider: `vllm/${model}`, model };
  },

  denormalizeRequest(payload: RequestPayload, original: Record<string, unknown>): Record<string, unknown> {
    return openAIAdapter.denormalizeRequest(payload, original);
  },

  normalizeResponse(raw: Record<string, unknown>, model: string): ResponsePayload {
    const payload = openAIAdapter.normalizeResponse(raw, model);
    return { ...payload, provider: `vllm/${model}` };
  },

  denormalizeResponse(payload: ResponsePayload, original: Record<string, unknown>): Record<string, unknown> {
    return openAIAdapter.denormalizeResponse(payload, original);
  },
};
