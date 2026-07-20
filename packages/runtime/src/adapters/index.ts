/**
 * @transparentguard/runtime — Provider Adapters (Phase 10)
 *
 * Re-exports the ProviderAdapter interface, all built-in adapters, and the
 * adapter loader (registerAdapter / resolveAdapter / listAdapters).
 */

// Core interface + types
export type { ProviderAdapter, ProviderAuthConfig, ProviderRegionInfo } from "./adapter.js";

// Built-in adapters
export { openAIAdapter } from "./openai.js";
export { anthropicAdapter } from "./anthropic.js";
export { groqAdapter } from "./groq.js";
export { vertexAdapter } from "./vertex.js";
export { mistralAdapter } from "./mistral.js";
export { vllmAdapter } from "./vllm.js";
export { bedrockAdapter } from "./bedrock.js";
export { deepSeekAdapter } from "./deepseek.js";
export { moonshotAdapter } from "./moonshot.js";
export { zhipuAdapter } from "./zhipu.js";
export { baichuanAdapter } from "./baichuan.js";

// Adapter loader
export {
  registerAdapter,
  resolveAdapter,
  listAdapters,
  hasAdapter,
} from "./loader.js";
