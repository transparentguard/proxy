/**
 * TransparentGuard — AWS Bedrock Provider Adapter
 *
 * Uses the Bedrock Converse API (unified interface across all Bedrock models).
 * Covers: bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0,
 *         bedrock/amazon.titan-text-premier-v1:0, etc.
 * API spec: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
 *
 * Bedrock Converse request format:
 * {
 *   "modelId": "anthropic.claude-3-sonnet-20240229-v1:0",
 *   "messages": [{ "role": "user", "content": [{ "text": "Hello" }] }],
 *   "system": [{ "text": "You are..." }],
 *   "inferenceConfig": { "maxTokens": 1024 }
 * }
 */

import type { ProviderAdapter } from "./adapter.js";
import type { RequestPayload, ResponsePayload, Message } from "../types.js";

interface BedrockContentBlock {
  text?: string;
  [key: string]: unknown;
}

interface BedrockMessage {
  role: "user" | "assistant";
  content: BedrockContentBlock[];
}

export const bedrockAdapter: ProviderAdapter = {
  providerId: "bedrock",
  displayName: "AWS Bedrock",
  isOpenAICompat: false,

  auth: {
    // Bedrock uses AWS SigV4 signing — the proxy handles auth at the transport layer.
    // This config covers the case where a pre-signed token or API key proxy is used.
    headerName: "Authorization",
    headerFormat: "AWS4-HMAC-SHA256 {key}",
    additionalHeaders: {
      "content-type": "application/json",
    },
  },

  region: {
    regions: [
      "us-east-1",
      "us-west-2",
      "eu-west-1",
      "eu-central-1",
      "ap-southeast-1",
      "ap-northeast-1",
    ],
    jurisdiction: "US",
    trainingJurisdiction: "US",
  },

  capabilities: [
    "chat",
    "function_calling",
    "vision",
    "code",
    "streaming",
    "embeddings",
  ],

  normalizeRequest(raw): RequestPayload {
    const messages = (raw["messages"] as BedrockMessage[]) ?? [];
    const system = (raw["system"] as BedrockContentBlock[]) ?? [];
    const modelId = String(raw["modelId"] ?? raw["model"] ?? "");
    const inferenceConfig = (raw["inferenceConfig"] as Record<string, unknown>) ?? {};

    const tpsMessages: Message[] = [];

    // System blocks → single system message
    if (system.length > 0) {
      const sysText = system
        .filter((b) => typeof b.text === "string")
        .map((b) => b.text ?? "")
        .join("\n");
      if (sysText) tpsMessages.push({ role: "system", content: sysText });
    }

    for (const msg of messages) {
      const text = msg.content
        .filter((b): b is BedrockContentBlock & { text: string } =>
          typeof b.text === "string",
        )
        .map((b) => b.text)
        .join("\n");
      tpsMessages.push({ role: msg.role, content: text });
    }

    return {
      messages: tpsMessages,
      provider: `bedrock/${modelId}`,
      model: modelId,
      max_tokens:
        typeof inferenceConfig["maxTokens"] === "number"
          ? inferenceConfig["maxTokens"]
          : undefined,
    };
  },

  denormalizeRequest(payload, original): Record<string, unknown> {
    const systemMsg = payload.messages.find((m) => m.role === "system");
    const bodyMessages: BedrockMessage[] = payload.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: [{ text: m.content ?? "" }],
      }));

    return {
      ...original,
      messages: bodyMessages,
      ...(systemMsg
        ? { system: [{ text: systemMsg.content ?? "" }] }
        : {}),
    };
  },

  normalizeResponse(raw, model): ResponsePayload {
    const output = (raw["output"] as Record<string, unknown>) ?? {};
    const message = (output["message"] as Record<string, unknown>) ?? {};
    const content = (message["content"] as BedrockContentBlock[]) ?? [];
    const text = content
      .filter((b): b is BedrockContentBlock & { text: string } =>
        typeof b.text === "string",
      )
      .map((b) => b.text)
      .join("\n");

    const usage = (raw["usage"] as Record<string, unknown>) ?? {};

    return {
      content: text,
      provider: `bedrock/${model}`,
      model,
      usage: {
        prompt_tokens:
          typeof usage["inputTokens"] === "number"
            ? usage["inputTokens"]
            : undefined,
        completion_tokens:
          typeof usage["outputTokens"] === "number"
            ? usage["outputTokens"]
            : undefined,
        total_tokens:
          typeof usage["totalTokens"] === "number"
            ? usage["totalTokens"]
            : undefined,
      },
    };
  },

  denormalizeResponse(payload, original): Record<string, unknown> {
    const orig = original as Record<string, unknown>;
    const output = (orig["output"] as Record<string, unknown>) ?? {};
    const message = (output["message"] as Record<string, unknown>) ?? {};

    return {
      ...orig,
      output: {
        ...output,
        message: {
          ...message,
          content: [{ text: payload.content }],
        },
      },
    };
  },
};
