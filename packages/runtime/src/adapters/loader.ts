/**
 * TransparentGuard Runtime — Provider Adapter Loader
 *
 * Maintains the built-in adapter registry and resolves a ProviderAdapter from
 * a TPS provider string (e.g. "openai/gpt-4o" → openAIAdapter).
 *
 * Community adapters can be registered at process startup via registerAdapter().
 */

import type { ProviderAdapter } from "./adapter.js";
import { assertFeature } from "../license/checker.js";
import type { LicenseStatus } from "../license/checker.js";
import { openAIAdapter } from "./openai.js";
import { anthropicAdapter } from "./anthropic.js";
import { groqAdapter } from "./groq.js";
import { vertexAdapter } from "./vertex.js";
import { mistralAdapter } from "./mistral.js";
import { vllmAdapter } from "./vllm.js";
import { bedrockAdapter } from "./bedrock.js";
import { deepSeekAdapter } from "./deepseek.js";
import { moonshotAdapter } from "./moonshot.js";
import { zhipuAdapter } from "./zhipu.js";
import { baichuanAdapter } from "./baichuan.js";

// ---------------------------------------------------------------------------
// Internal registry
// ---------------------------------------------------------------------------

const ADAPTER_REGISTRY = new Map<string, ProviderAdapter>();

function seed(adapter: ProviderAdapter): void {
  ADAPTER_REGISTRY.set(adapter.providerId.toLowerCase(), adapter);
}

// Seed all built-in adapters
seed(openAIAdapter);
seed(anthropicAdapter);
seed(groqAdapter);
seed(vertexAdapter);
seed(mistralAdapter);
seed(vllmAdapter);
seed(bedrockAdapter);
seed(deepSeekAdapter);
seed(moonshotAdapter);
seed(zhipuAdapter);
seed(baichuanAdapter);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a custom or community ProviderAdapter.
 * If an adapter with the same providerId is already registered, it is replaced.
 *
 * @example
 * ```ts
 * import { registerAdapter } from "@transparentguard/runtime";
 * registerAdapter({
 *   providerId: "myco",
 *   displayName: "MyCo LLM API",
 *   // ... full ProviderAdapter implementation
 * });
 * ```
 */
export function registerAdapter(adapter: ProviderAdapter, license?: LicenseStatus): void {
  // Gate 2: custom adapters require Growth tier. Pass your LicenseStatus to enforce.
  if (license !== undefined) {
    assertFeature(license, "custom_adapter", "Custom provider adapters (registerAdapter)");
  }
  ADAPTER_REGISTRY.set(adapter.providerId.toLowerCase(), adapter);
}

/**
 * Resolve a ProviderAdapter from a TPS provider string.
 *
 * The provider string format is "{providerId}/{modelId}" (e.g., "openai/gpt-4o").
 * Only the prefix segment before the first "/" is used for lookup.
 * Returns null when no adapter is registered for the given provider.
 *
 * @example
 * ```ts
 * const adapter = resolveAdapter("openai/gpt-4o");   // → openAIAdapter
 * const adapter = resolveAdapter("groq/mixtral-8x7b"); // → groqAdapter
 * const adapter = resolveAdapter("unknown/model");    // → null
 * ```
 */
export function resolveAdapter(providerString: string): ProviderAdapter | null {
  const providerId = providerString.split("/")[0]?.toLowerCase() ?? "";
  return ADAPTER_REGISTRY.get(providerId) ?? null;
}

/**
 * List all currently registered adapters (built-in + community).
 * Returns a stable copy — mutation of the returned array does not affect the registry.
 */
export function listAdapters(): ProviderAdapter[] {
  return Array.from(ADAPTER_REGISTRY.values());
}

/**
 * Check whether an adapter is registered for a given provider string or provider ID.
 */
export function hasAdapter(providerStringOrId: string): boolean {
  return resolveAdapter(providerStringOrId) !== null;
}
