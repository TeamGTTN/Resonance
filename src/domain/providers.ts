export type SummaryProviderId = "ollama" | "gemini" | "openai" | "anthropic";

export interface ProviderCapabilities {
  id: SummaryProviderId;
  label: string;
  tier: "tier1" | "experimental";
  kind: "local" | "cloud";
  requiresApiKey: boolean;
  requiresEndpoint: boolean;
  defaultModel: string;
  description: string;
}

export const PROVIDER_CAPABILITIES: Record<SummaryProviderId, ProviderCapabilities> = {
  ollama: {
    id: "ollama",
    label: "Ollama",
    tier: "tier1",
    kind: "local",
    requiresApiKey: false,
    requiresEndpoint: true,
    defaultModel: "gemma3",
    description: "Default local-first summary provider for Resonance.",
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    tier: "experimental",
    kind: "cloud",
    requiresApiKey: true,
    requiresEndpoint: false,
    defaultModel: "gemini-2.5-flash",
    description: "Optional cloud provider.",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    tier: "experimental",
    kind: "cloud",
    requiresApiKey: true,
    requiresEndpoint: false,
    defaultModel: "gpt-4o-mini",
    description: "Optional cloud provider.",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    tier: "experimental",
    kind: "cloud",
    requiresApiKey: true,
    requiresEndpoint: false,
    defaultModel: "claude-3-5-sonnet-latest",
    description: "Optional cloud provider.",
  },
};

export function getProviderCapabilities(provider: SummaryProviderId | undefined): ProviderCapabilities {
  return PROVIDER_CAPABILITIES[provider ?? "ollama"];
}

export function getSelectedSummaryModel(summary: {
  provider: SummaryProviderId;
  ollamaModel: string;
  geminiModel: string;
  openaiModel: string;
  anthropicModel: string;
}): string {
  switch (summary.provider) {
    case "gemini":
      return summary.geminiModel || PROVIDER_CAPABILITIES.gemini.defaultModel;
    case "openai":
      return summary.openaiModel || PROVIDER_CAPABILITIES.openai.defaultModel;
    case "anthropic":
      return summary.anthropicModel || PROVIDER_CAPABILITIES.anthropic.defaultModel;
    case "ollama":
    default:
      return summary.ollamaModel || PROVIDER_CAPABILITIES.ollama.defaultModel;
  }
}
