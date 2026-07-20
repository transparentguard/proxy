/**
 * TransparentGuard — Google Vertex AI Provider Adapter
 *
 * Covers Vertex AI Generative AI API (Gemini models via Vertex).
 * Uses the generateContent endpoint format.
 * Covers: vertex/gemini-1.5-pro, vertex/gemini-1.5-flash, etc.
 * API spec: https://cloud.google.com/vertex-ai/generative-ai/docs/reference/rest
 *
 * Vertex request format:
 * {
 *   "contents": [{ "role": "user", "parts": [{ "text": "..." }] }],
 *   "systemInstruction": { "parts": [{ "text": "..." }] },
 *   "generationConfig": { "maxOutputTokens": 1024 }
 * }
 */

import type { ProviderAdapter } from "./adapter.js";
import type { RequestPayload, ResponsePayload, Message } from "../types.js";

interface VertexPart {
  text?: string;
  [key: string]: unknown;
}

interface VertexContent {
  role?: string;
  parts?: VertexPart[];
  [key: string]: unknown;
}

export const vertexAdapter: ProviderAdapter = {
  providerId: "vertex",
  displayName: "Google Vertex AI",
  isOpenAICompat: false,

  auth: {
    headerName: "Authorization",
    headerFormat: "Bearer {key}",
    additionalHeaders: {
      "x-goog-user-project": "",
    },
  },

  region: {
    regions: [
      "us-central1",
      "us-east4",
      "europe-west1",
      "europe-west4",
      "asia-northeast1",
      "asia-southeast1",
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
    const contents = (raw["contents"] as VertexContent[]) ?? [];
    const systemInstruction = raw["systemInstruction"] as VertexContent | undefined;
    const genConfig = (raw["generationConfig"] as Record<string, unknown>) ?? {};
    const model = String(raw["model"] ?? "gemini-1.5-pro");

    const messages: Message[] = [];

    // System instruction → system message
    if (systemInstruction?.parts) {
      const sysText = systemInstruction.parts
        .filter((p) => typeof p.text === "string")
        .map((p) => p.text ?? "")
        .join("\n");
      if (sysText) messages.push({ role: "system", content: sysText });
    }

    for (const content of contents) {
      const role =
        content.role === "model" ? "assistant" : ((content.role ?? "user") as Message["role"]);
      const text =
        content.parts
          ?.filter((p): p is VertexPart & { text: string } => typeof p.text === "string")
          .map((p) => p.text)
          .join("\n") ?? "";
      messages.push({ role, content: text });
    }

    return {
      messages,
      provider: `vertex/${model}`,
      model,
      max_tokens:
        typeof genConfig["maxOutputTokens"] === "number"
          ? genConfig["maxOutputTokens"]
          : undefined,
    };
  },

  denormalizeRequest(payload, original): Record<string, unknown> {
    const systemMsg = payload.messages.find((m) => m.role === "system");
    const bodyMessages = payload.messages.filter((m) => m.role !== "system");

    const contents: VertexContent[] = bodyMessages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content ?? "" }],
    }));

    return {
      ...original,
      contents,
      ...(systemMsg
        ? { systemInstruction: { parts: [{ text: systemMsg.content ?? "" }] } }
        : {}),
    };
  },

  normalizeResponse(raw, model): ResponsePayload {
    const candidates =
      (raw["candidates"] as Array<Record<string, unknown>>) ?? [];
    const first = candidates[0] ?? {};
    const content = (first["content"] as VertexContent) ?? {};
    const text =
      content.parts
        ?.filter((p): p is VertexPart & { text: string } => typeof p.text === "string")
        .map((p) => p.text)
        .join("\n") ?? "";

    const usageMetadata = (raw["usageMetadata"] as Record<string, unknown>) ?? {};

    return {
      content: text,
      provider: `vertex/${model}`,
      model,
      usage: {
        prompt_tokens:
          typeof usageMetadata["promptTokenCount"] === "number"
            ? usageMetadata["promptTokenCount"]
            : undefined,
        completion_tokens:
          typeof usageMetadata["candidatesTokenCount"] === "number"
            ? usageMetadata["candidatesTokenCount"]
            : undefined,
      },
    };
  },

  denormalizeResponse(payload, original): Record<string, unknown> {
    const orig = original as Record<string, unknown>;
    const candidates =
      (orig["candidates"] as Array<Record<string, unknown>>) ?? [];
    return {
      ...orig,
      candidates: candidates.map((cand, i) => {
        if (i === 0) {
          return {
            ...cand,
            content: {
              role: "model",
              parts: [{ text: payload.content }],
            },
          };
        }
        return cand;
      }),
    };
  },
};
