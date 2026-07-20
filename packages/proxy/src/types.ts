/**
 * TransparentGuard Proxy — Shared Types
 */

import type { TransparentGuard } from "@transparentguard/runtime";

// ---------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------

export interface ProxyConfig {
  tg: TransparentGuard;
  /** Full upstream base URL, e.g. https://api.openai.com */
  upstream: string;
  /** Optional override for the upstream API key (defaults to client Authorization header) */
  upstreamApiKey?: string;
  port: number;
  logLevel: "debug" | "info" | "error";
}

// ---------------------------------------------------------------------------
// Request context — populated once per request, threaded through handlers
// ---------------------------------------------------------------------------

export interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  upstreamApiKey: string;
  startMs: number;
  /** Customer's TransparentGuard API key (before Unkey verification) */
  tgApiKey: string;
  /** Unkey key ID — empty string if Unkey not configured */
  tgKeyId: string;
  /** Customer tier resolved from Unkey metadata — "free" if not configured */
  tier: string;
}

// ---------------------------------------------------------------------------
// OpenAI wire types (minimal — only what the proxy needs to inspect)
// ---------------------------------------------------------------------------

export interface OpenAIMessage {
  role: string;
  content?: string | null;
}

export interface OpenAIChatBody {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface OpenAIChatChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
  };
  finish_reason: string | null;
}

export interface OpenAIChatCompletion {
  id: string;
  object: string;
  model: string;
  choices: OpenAIChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  [key: string]: unknown;
}

export interface OpenAIStreamDelta {
  role?: string;
  content?: string | null;
}

export interface OpenAIStreamChoice {
  index: number;
  delta: OpenAIStreamDelta;
  finish_reason: string | null;
}

export interface OpenAIChatChunk {
  id: string;
  object: string;
  model: string;
  choices: OpenAIStreamChoice[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Anthropic wire types (minimal)
// ---------------------------------------------------------------------------

export interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
}

export interface AnthropicCreateBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  stream?: boolean;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface AnthropicResponseContent {
  type: string;
  text?: string;
}

export interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  model: string;
  content: AnthropicResponseContent[];
  stop_reason: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// OpenAI-format error (used for blocked responses)
// ---------------------------------------------------------------------------

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    code: string;
    param?: string | null;
  };
}
