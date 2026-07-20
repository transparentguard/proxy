/**
 * TransparentGuard — Anthropic Provider Adapter
 *
 * Covers: anthropic/claude-3-5-sonnet, anthropic/claude-3-haiku, etc.
 * API spec: https://docs.anthropic.com/en/api/messages
 */

import type { ProviderAdapter } from "./adapter.js";
import type { RequestPayload, ResponsePayload, Message } from "../types.js";

export const anthropicAdapter: ProviderAdapter = {
  providerId: "anthropic",
  displayName: "Anthropic",
  isOpenAICompat: false,

  auth: {
    headerName: "x-api-key",
    headerFormat: "{key}",
    additionalHeaders: {
      "anthropic-version": "2023-06-01",
    },
  },

  region: {
    regions: ["us-east-1", "eu-west-3"],
    jurisdiction: "US",
    trainingJurisdiction: "US",
  },

  capabilities: [
    "chat",
    "function_calling",
    "vision",
    "code",
    "streaming",
  ],

  normalizeRequest(raw: Record<string, unknown>): RequestPayload {
    const msgs = (raw["messages"] as Array<Record<string, unknown>>) ?? [];
    const model = String(raw["model"] ?? "");
    const systemPrompt = raw["system"] ? String(raw["system"]) : undefined;

    const messages: Message[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    for (const m of msgs) {
      const content = m["content"];
      let text: string;
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = (content as Array<Record<string, unknown>>)
          .filter((b) => b["type"] === "text")
          .map((b) => String(b["text"] ?? ""))
          .join("\n");
      } else {
        text = "";
      }
      messages.push({
        role: m["role"] as "user" | "assistant",
        content: text,
      });
    }

    return {
      messages,
      provider: `anthropic/${model}`,
      model,
      max_tokens:
        typeof raw["max_tokens"] === "number" ? raw["max_tokens"] : undefined,
    };
  },

  denormalizeRequest(payload: RequestPayload, original: Record<string, unknown>): Record<string, unknown> {
    const systemMsg = payload.messages.find((m) => m.role === "system");
    const bodyMessages = payload.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content ?? "" }));

    return {
      ...original,
      messages: bodyMessages,
      ...(systemMsg ? { system: systemMsg.content } : {}),
    };
  },

  normalizeResponse(raw: Record<string, unknown>, model: string): ResponsePayload {
    const content = (raw["content"] as Array<Record<string, unknown>>) ?? [];
    const text = content
      .filter((b) => b["type"] === "text")
      .map((b) => String(b["text"] ?? ""))
      .join("\n");
    const usage = (raw["usage"] as Record<string, unknown>) ?? {};

    return {
      content: text,
      provider: `anthropic/${model}`,
      model,
      usage: {
        prompt_tokens:
          typeof usage["input_tokens"] === "number"
            ? usage["input_tokens"]
            : undefined,
        completion_tokens:
          typeof usage["output_tokens"] === "number"
            ? usage["output_tokens"]
            : undefined,
      },
    };
  },

  denormalizeResponse(payload: ResponsePayload, original: Record<string, unknown>): Record<string, unknown> {
    return {
      ...original,
      content: [{ type: "text", text: payload.content }],
    };
  },
};
