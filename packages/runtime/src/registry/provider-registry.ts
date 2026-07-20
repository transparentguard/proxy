/**
 * TransparentGuard Runtime — Embedded Provider Registry
 *
 * Loaded at module init from the bundled registry JSON.
 * Entries are keyed by provider slug (e.g. "openai", "anthropic").
 * A per-model lookup resolves "openai/gpt-4o" → the "openai" entry,
 * then checks the models[] sub-array for model-level overrides.
 */

export interface ProviderRegistryEntry {
  /** Top-level provider slug: "openai", "anthropic", "google", etc. */
  id: string;
  name: string;
  /** ISO 3166-1 alpha-2: where the company is headquartered */
  headquarters_jurisdiction: string;
  /** ISO 3166-1 alpha-2 codes where this provider trains its models */
  training_jurisdictions: string[];
  /** Cloud regions where processing can occur */
  processing_regions: string[];
  /** Published capabilities across this provider's model family */
  capabilities: string[];
  /** Aggregate risk tier for this provider's flagship models */
  risk_tier: "low" | "medium" | "high" | "critical";
  /** Maximum context window (tokens) across flagship models */
  max_context_window: number;
  /** ISO-8601 date of latest known training data cutoff */
  training_cutoff?: string;
  /** Compliance attestations the provider holds at the company level */
  attestations: string[];
  /** Whether this provider returns a TG-compatible signed response header */
  supports_signed_responses: boolean;
  /** Model-level overrides — merge with provider defaults */
  models?: Array<{
    id: string;
    capabilities?: string[];
    risk_tier?: "low" | "medium" | "high" | "critical";
    max_context_window?: number;
    training_cutoff?: string;
    attestations?: string[];
    processing_regions?: string[];
  }>;
}

const REGISTRY_DATA: ProviderRegistryEntry[] = [
  {
    id: "openai",
    name: "OpenAI",
    headquarters_jurisdiction: "US",
    training_jurisdictions: ["US"],
    processing_regions: [
      "us-east-1", "us-east-2", "us-west-2",
      "eu-west-1", "eu-central-1",
      "ap-southeast-1", "ap-northeast-1",
    ],
    capabilities: [
      "text_generation", "function_calling", "vision",
      "structured_output", "embedding", "fine_tuning",
      "code_generation", "reasoning",
    ],
    risk_tier: "medium",
    max_context_window: 128000,
    training_cutoff: "2024-04-01",
    attestations: ["soc2-type2", "iso-27001", "hipaa-baa", "gdpr-dpa"],
    supports_signed_responses: false,
    models: [
      {
        id: "gpt-4o",
        capabilities: ["text_generation", "function_calling", "vision", "structured_output", "code_generation"],
        max_context_window: 128000,
        training_cutoff: "2024-04-01",
      },
      {
        id: "gpt-4o-mini",
        capabilities: ["text_generation", "function_calling", "structured_output", "code_generation"],
        max_context_window: 128000,
        training_cutoff: "2024-04-01",
      },
      {
        id: "o1",
        capabilities: ["text_generation", "reasoning", "code_generation"],
        max_context_window: 200000,
        training_cutoff: "2024-10-01",
      },
      {
        id: "o3",
        capabilities: ["text_generation", "reasoning", "code_generation", "vision"],
        max_context_window: 200000,
        training_cutoff: "2025-06-01",
      },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    headquarters_jurisdiction: "US",
    training_jurisdictions: ["US"],
    processing_regions: [
      "us-east-1", "us-west-2",
      "eu-west-1", "eu-central-1",
      "ap-southeast-1",
    ],
    capabilities: [
      "text_generation", "function_calling", "vision",
      "structured_output", "code_generation", "reasoning",
    ],
    risk_tier: "medium",
    max_context_window: 200000,
    training_cutoff: "2024-08-01",
    attestations: ["soc2-type2", "hipaa-baa", "gdpr-dpa"],
    supports_signed_responses: false,
    models: [
      {
        id: "claude-opus-4-5",
        capabilities: ["text_generation", "function_calling", "vision", "structured_output", "code_generation", "reasoning"],
        max_context_window: 200000,
        training_cutoff: "2025-03-01",
      },
      {
        id: "claude-sonnet-4-5",
        capabilities: ["text_generation", "function_calling", "vision", "structured_output", "code_generation"],
        max_context_window: 200000,
        training_cutoff: "2025-03-01",
      },
      {
        id: "claude-haiku-3-5",
        capabilities: ["text_generation", "function_calling", "structured_output"],
        max_context_window: 200000,
        training_cutoff: "2024-07-01",
      },
    ],
  },
  {
    id: "google",
    name: "Google DeepMind",
    headquarters_jurisdiction: "US",
    training_jurisdictions: ["US"],
    processing_regions: [
      "us-central1", "us-east1", "us-east4",
      "europe-west1", "europe-west4",
      "asia-east1", "asia-southeast1",
    ],
    capabilities: [
      "text_generation", "function_calling", "vision",
      "structured_output", "embedding", "code_generation",
      "reasoning", "multimodal",
    ],
    risk_tier: "medium",
    max_context_window: 2000000,
    training_cutoff: "2025-01-01",
    attestations: ["soc2-type2", "iso-27001", "hipaa-baa", "gdpr-dpa", "fedramp-moderate"],
    supports_signed_responses: false,
    models: [
      {
        id: "gemini-2.5-pro",
        capabilities: ["text_generation", "function_calling", "vision", "reasoning", "multimodal", "code_generation"],
        max_context_window: 2000000,
        training_cutoff: "2025-01-01",
      },
      {
        id: "gemini-2.5-flash",
        capabilities: ["text_generation", "function_calling", "vision", "multimodal"],
        max_context_window: 1000000,
        training_cutoff: "2025-01-01",
      },
    ],
  },
  {
    id: "mistral",
    name: "Mistral AI",
    headquarters_jurisdiction: "FR",
    training_jurisdictions: ["FR", "EU"],
    processing_regions: [
      "eu-west-1", "eu-central-1", "eu-west-3",
    ],
    capabilities: [
      "text_generation", "function_calling", "structured_output",
      "embedding", "code_generation",
    ],
    risk_tier: "medium",
    max_context_window: 128000,
    training_cutoff: "2024-09-01",
    attestations: ["soc2-type2", "iso-27001", "gdpr-dpa"],
    supports_signed_responses: false,
    models: [
      {
        id: "mistral-large-latest",
        capabilities: ["text_generation", "function_calling", "structured_output", "code_generation"],
        max_context_window: 128000,
      },
      {
        id: "codestral-latest",
        capabilities: ["text_generation", "code_generation", "function_calling"],
        max_context_window: 256000,
      },
    ],
  },
  {
    id: "cohere",
    name: "Cohere",
    headquarters_jurisdiction: "CA",
    training_jurisdictions: ["US", "CA"],
    processing_regions: [
      "us-east-1", "us-west-2",
      "eu-west-1",
      "ap-southeast-1",
    ],
    capabilities: [
      "text_generation", "function_calling", "embedding",
      "reranking", "structured_output",
    ],
    risk_tier: "medium",
    max_context_window: 128000,
    training_cutoff: "2024-03-01",
    attestations: ["soc2-type2", "hipaa-baa", "gdpr-dpa"],
    supports_signed_responses: false,
  },
  {
    id: "aws-bedrock",
    name: "AWS Bedrock",
    headquarters_jurisdiction: "US",
    training_jurisdictions: ["US"],
    processing_regions: [
      "us-east-1", "us-west-2",
      "eu-west-1", "eu-central-1",
      "ap-southeast-1", "ap-northeast-1",
    ],
    capabilities: [
      "text_generation", "function_calling", "vision",
      "embedding", "structured_output", "code_generation",
    ],
    risk_tier: "low",
    max_context_window: 200000,
    attestations: [
      "soc2-type2", "iso-27001", "hipaa-baa", "gdpr-dpa",
      "fedramp-high", "pci-dss",
    ],
    supports_signed_responses: false,
  },
  {
    id: "azure-openai",
    name: "Microsoft Azure OpenAI",
    headquarters_jurisdiction: "US",
    training_jurisdictions: ["US"],
    processing_regions: [
      "eastus", "eastus2", "westus", "westus2", "westus3",
      "northeurope", "westeurope", "swedencentral", "switzerlandnorth",
      "eastasia", "southeastasia", "australiaeast", "japaneast",
    ],
    capabilities: [
      "text_generation", "function_calling", "vision",
      "structured_output", "embedding", "code_generation", "reasoning",
    ],
    risk_tier: "low",
    max_context_window: 128000,
    training_cutoff: "2024-04-01",
    attestations: [
      "soc2-type2", "iso-27001", "hipaa-baa", "gdpr-dpa",
      "fedramp-high", "pci-dss", "hitrust",
    ],
    supports_signed_responses: false,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    headquarters_jurisdiction: "CN",
    training_jurisdictions: ["CN"],
    processing_regions: ["cn-east-1", "cn-north-1"],
    capabilities: [
      "text_generation", "function_calling", "code_generation", "reasoning",
    ],
    risk_tier: "high",
    max_context_window: 64000,
    training_cutoff: "2024-07-01",
    attestations: [],
    supports_signed_responses: false,
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    headquarters_jurisdiction: "local",
    training_jurisdictions: [],
    processing_regions: ["local"],
    capabilities: [
      "text_generation", "function_calling", "vision",
      "embedding", "code_generation",
    ],
    risk_tier: "low",
    max_context_window: 128000,
    attestations: [],
    supports_signed_responses: false,
  },
  {
    id: "hf",
    name: "Hugging Face Inference",
    headquarters_jurisdiction: "US",
    training_jurisdictions: [],
    processing_regions: ["us-east-1", "eu-west-1"],
    capabilities: ["text_generation", "embedding", "vision", "code_generation"],
    risk_tier: "medium",
    max_context_window: 128000,
    attestations: ["soc2-type2", "gdpr-dpa"],
    supports_signed_responses: false,
  },
  {
    id: "replicate",
    name: "Replicate",
    headquarters_jurisdiction: "US",
    training_jurisdictions: [],
    processing_regions: ["us-east-1", "us-west-2"],
    capabilities: ["text_generation", "vision", "embedding", "code_generation"],
    risk_tier: "medium",
    max_context_window: 128000,
    attestations: ["soc2-type2"],
    supports_signed_responses: false,
  },
  {
    id: "local",
    name: "Local / Self-Hosted",
    headquarters_jurisdiction: "local",
    training_jurisdictions: [],
    processing_regions: ["local"],
    capabilities: [
      "text_generation", "function_calling", "vision",
      "embedding", "code_generation",
    ],
    risk_tier: "low",
    max_context_window: 128000,
    attestations: [],
    supports_signed_responses: false,
  },
];

// ---------------------------------------------------------------------------
// Registry class
// ---------------------------------------------------------------------------

class TGProviderRegistry {
  private readonly bySlug: Map<string, ProviderRegistryEntry>;

  constructor(entries: ProviderRegistryEntry[]) {
    this.bySlug = new Map(entries.map((e) => [e.id, e]));
  }

  /**
   * Resolve "openai/gpt-4o" → provider entry with model-level overrides merged.
   * Resolve "openai" → provider entry with no model override.
   */
  getProvider(providerModel: string): ProviderRegistryEntry | null {
    const slashIdx = providerModel.indexOf("/");
    const slug = slashIdx === -1 ? providerModel : providerModel.slice(0, slashIdx);
    const modelId = slashIdx === -1 ? undefined : providerModel.slice(slashIdx + 1);

    const base = this.bySlug.get(slug);
    if (!base) return null;
    if (!modelId || !base.models?.length) return base;

    const modelEntry = base.models.find((m) => m.id === modelId);
    if (!modelEntry) return base;

    // Merge model-level overrides on top of provider defaults
    return {
      ...base,
      capabilities: modelEntry.capabilities ?? base.capabilities,
      risk_tier: modelEntry.risk_tier ?? base.risk_tier,
      max_context_window: modelEntry.max_context_window ?? base.max_context_window,
      training_cutoff: modelEntry.training_cutoff ?? base.training_cutoff,
      attestations: modelEntry.attestations
        ? [...new Set([...base.attestations, ...modelEntry.attestations])]
        : base.attestations,
      processing_regions: modelEntry.processing_regions ?? base.processing_regions,
    };
  }

  /** List all provider slugs */
  listProviders(): string[] {
    return [...this.bySlug.keys()];
  }
}

export const PROVIDER_REGISTRY = new TGProviderRegistry(REGISTRY_DATA);
