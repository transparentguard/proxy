/**
 * TransparentGuard — DeepSeek Provider Adapter
 *
 * DeepSeek is OpenAI Chat Completions API-compatible.
 * Covers: deepseek/deepseek-chat, deepseek/deepseek-coder, deepseek/deepseek-reasoner, etc.
 * API spec: https://platform.deepseek.com/api-docs/
 *
 * Note: DeepSeek processes data in China (CN). Policies using data_sovereignty with
 * blocked_processor_jurisdictions: [CN] or blocked_training_jurisdictions: [CN]
 * will block requests routed to this provider.
 */

import type { ProviderAdapter } from "./adapter.js";
import { openAIAdapter } from "./openai.js";
import type { RequestPayload, ResponsePayload } from "../types.js";

export const deepSeekAdapter: ProviderAdapter = {
  providerId: "deepseek",
  displayName: "DeepSeek",
  isOpenAICompat: true,

  auth: {
    headerName: "Authorization",
    headerFormat: "Bearer {key}",
  },

  region: {
    regions: ["cn-hangzhou"],
    jurisdiction: "CN",
    trainingJurisdiction: "CN",
  },

  capabilities: ["chat", "code", "streaming", "function_calling"],

  normalizeRequest(raw: Record<string, unknown>): RequestPayload {
    const payload = openAIAdapter.normalizeRequest(raw);
    const model = String(raw["model"] ?? "");
    return { ...payload, provider: `deepseek/${model}`, model };
  },

  denormalizeRequest(payload: RequestPayload, original: Record<string, unknown>): Record<string, unknown> {
    return openAIAdapter.denormalizeRequest(payload, original);
  },

  normalizeResponse(raw: Record<string, unknown>, model: string): ResponsePayload {
    const payload = openAIAdapter.normalizeResponse(raw, model);
    return { ...payload, provider: `deepseek/${model}` };
  },

  denormalizeResponse(payload: ResponsePayload, original: Record<string, unknown>): Record<string, unknown> {
    return openAIAdapter.denormalizeResponse(payload, original);
  },
};
