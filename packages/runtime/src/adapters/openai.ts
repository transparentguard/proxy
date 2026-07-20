/**
 * TransparentGuard — OpenAI Provider Adapter
 *
 * Covers: openai/gpt-4o, openai/gpt-4-turbo, openai/gpt-3.5-turbo, etc.
 * API spec: https://platform.openai.com/docs/api-reference/chat
 */

import type { ProviderAdapter } from "./adapter.js";
import type { RequestPayload, ResponsePayload, Message } from "../types.js";

export const openAIAdapter: ProviderAdapter = {
  providerId: "openai",
  displayName: "OpenAI",
  isOpenAICompat: true,

  auth: {
    headerName: "Authorization",
    headerFormat: "Bearer {key}",
  },

  region: {
    regions: ["us-east-1", "eu-west-1", "ap-southeast-1"],
    jurisdiction: "US",
    trainingJurisdiction: "US",
  },

  capabilities: [
    "chat",
    "function_calling",
    "vision",
    "embeddings",
    "audio",
    "code",
    "streaming",
    "realtime",
  ],

  normalizeRequest(raw: Record<string, unknown>): RequestPayload {
    const msgs = (raw["messages"] as Array<Record<string, unknown>>) ?? [];
    const model = String(raw["model"] ?? "");
    return {
      messages: msgs.map(
        (m): Message => ({
          role: m["role"] as Message["role"],
          content: typeof m["content"] === "string" ? m["content"] : null,
          name: m["name"] as string | undefined,
          tool_call_id: m["tool_call_id"] as string | undefined,
        }),
      ),
      provider: `openai/${model}`,
      model,
      max_tokens:
        typeof raw["max_tokens"] === "number" ? raw["max_tokens"] : undefined,
    };
  },

  denormalizeRequest(payload: RequestPayload, original: Record<string, unknown>): Record<string, unknown> {
    return {
      ...original,
      messages: payload.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })),
    };
  },

  normalizeResponse(raw: Record<string, unknown>, model: string): ResponsePayload {
    const choices = (raw["choices"] as Array<Record<string, unknown>>) ?? [];
    const firstChoice = choices[0] ?? {};
    const message = (firstChoice["message"] as Record<string, unknown>) ?? {};
    const usage = (raw["usage"] as Record<string, unknown>) ?? {};
    return {
      content: String(message["content"] ?? ""),
      provider: `openai/${model}`,
      model,
      usage: {
        prompt_tokens:
          typeof usage["prompt_tokens"] === "number"
            ? usage["prompt_tokens"]
            : undefined,
        completion_tokens:
          typeof usage["completion_tokens"] === "number"
            ? usage["completion_tokens"]
            : undefined,
        total_tokens:
          typeof usage["total_tokens"] === "number"
            ? usage["total_tokens"]
            : undefined,
      },
    };
  },

  denormalizeResponse(payload: ResponsePayload, original: Record<string, unknown>): Record<string, unknown> {
    const orig = original as Record<string, unknown>;
    const choices = (orig["choices"] as Array<Record<string, unknown>>) ?? [];
    return {
      ...orig,
      choices: choices.map((choice, i) => {
        if (i === 0) {
          return {
            ...choice,
            message: {
              ...((choice["message"] as Record<string, unknown>) ?? {}),
              content: payload.content,
            },
          };
        }
        return choice;
      }),
    };
  },
};
