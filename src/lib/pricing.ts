/**
 * OpenClaw Model Pricing
 * Based on OpenRouter and Anthropic pricing as of Feb 2026
 * All prices in USD per million tokens
 */

export interface ModelPricing {
  id: string;
  name: string;
  alias?: string;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  contextWindow: number;
}

export const MODEL_PRICING: ModelPricing[] = [
  // OpenAI GPT-5 Series
  {
    id: "openai/gpt-5.4-codex",
    name: "GPT-5.4 Codex",
    alias: "gpt-5.4-codex",
    inputPricePerMillion: 10.00,
    outputPricePerMillion: 30.00,
    contextWindow: 128000,
  },
  {
    id: "openai/gpt-5.4",
    name: "GPT-5.4",
    alias: "gpt-5.4",
    inputPricePerMillion: 5.00,
    outputPricePerMillion: 15.00,
    contextWindow: 128000,
  },
  {
    id: "openai/gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    alias: "gpt-5.4-mini",
    inputPricePerMillion: 0.50,
    outputPricePerMillion: 1.50,
    contextWindow: 128000,
  },
  // OpenAI GPT-4 Series
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    alias: "gpt-4o",
    inputPricePerMillion: 5.00,
    outputPricePerMillion: 15.00,
    contextWindow: 128000,
  },
  // Anthropic Claude Series
  {
    id: "anthropic/claude-opus-4-7",
    name: "Opus 4.7",
    alias: "opus-4-7",
    inputPricePerMillion: 15.00,
    outputPricePerMillion: 75.00,
    contextWindow: 1_000_000,
  },
  {
    id: "anthropic/claude-opus-4-6",
    name: "Opus 4.6",
    alias: "opus",
    inputPricePerMillion: 15.00,
    outputPricePerMillion: 75.00,
    contextWindow: 200000,
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    name: "Sonnet 4.6",
    alias: "sonnet-4-6",
    inputPricePerMillion: 3.00,
    outputPricePerMillion: 15.00,
    contextWindow: 200000,
  },
  {
    id: "anthropic/claude-sonnet-4-5",
    name: "Sonnet 4.5",
    alias: "sonnet",
    inputPricePerMillion: 3.00,
    outputPricePerMillion: 15.00,
    contextWindow: 200000,
  },
  {
    id: "anthropic/claude-haiku-4-5",
    name: "Haiku 4.5",
    alias: "haiku-4-5",
    inputPricePerMillion: 1.00,
    outputPricePerMillion: 5.00,
    contextWindow: 200000,
  },
  // Google Gemini Series
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    alias: "gemini-pro",
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 5.00,
    contextWindow: 2000000,
  },
  // Moonshot Kimi
  {
    id: "moonshot/moonshot-v1-auto",
    name: "Kimi (Moonshot)",
    alias: "kimi",
    inputPricePerMillion: 0.80,
    outputPricePerMillion: 2.40,
    contextWindow: 128000,
  },
];

/**
 * Calculate cost for a given model and token usage.
 *
 * Cache tokens follow Anthropic-style multipliers relative to the input price:
 * - cache_read:     0.1x input  (Anthropic cache hit discount)
 * - cache_creation: 1.25x input (Anthropic cache write premium)
 *
 * For non-Anthropic providers OpenClaw normalizes cache_read to `cacheRead`
 * (mapped from OpenAI's `cached_tokens` / Gemini's `cachedContentTokenCount`)
 * and leaves `cacheWrite` at 0, so the same formula degrades gracefully.
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheCreationTokens: number = 0,
): number {
  const pricing = MODEL_PRICING.find(
    (p) => p.id === modelId || p.alias === modelId
  );

  const inputPrice = pricing?.inputPricePerMillion ?? 5.0;
  const outputPrice = pricing?.outputPricePerMillion ?? 15.0;

  if (!pricing) {
    console.warn(`Unknown model: ${modelId}, using default pricing`);
  }

  const cacheReadPrice = inputPrice * 0.1;
  const cacheCreationPrice = inputPrice * 1.25;

  return (
    (inputTokens / 1_000_000) * inputPrice +
    (outputTokens / 1_000_000) * outputPrice +
    (cacheReadTokens / 1_000_000) * cacheReadPrice +
    (cacheCreationTokens / 1_000_000) * cacheCreationPrice
  );
}

/**
 * Get human-readable model name
 */
export function getModelName(modelId: string): string {
  const pricing = MODEL_PRICING.find(
    (p) => p.id === modelId || p.alias === modelId
  );
  return pricing?.name || modelId;
}

/**
 * Normalize model ID (handle aliases and different formats)
 */
export function normalizeModelId(modelId: string): string {
  const aliasMap: Record<string, string> = {
    "gpt-5.4-codex": "openai/gpt-5.4-codex",
    "gpt-5.4": "openai/gpt-5.4",
    "gpt-5.4-mini": "openai/gpt-5.4-mini",
    "gpt-4-turbo": "openai/gpt-4-turbo",
    "gpt-4o": "openai/gpt-4o",
    "opus": "anthropic/claude-opus-4-6",
    "opus-4-7": "anthropic/claude-opus-4-7",
    "claude-opus-4-7": "anthropic/claude-opus-4-7",
    "claude-opus-4-6": "anthropic/claude-opus-4-6",
    "sonnet": "anthropic/claude-sonnet-4-5",
    "sonnet-4-6": "anthropic/claude-sonnet-4-6",
    "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
    "haiku": "anthropic/claude-haiku-3-5",
    "haiku-4-5": "anthropic/claude-haiku-4-5",
    "claude-haiku-4-5": "anthropic/claude-haiku-4-5",
    "claude-sonnet-4-5": "anthropic/claude-sonnet-4-5",
    "gemini-pro": "google/gemini-2.5-pro",
    "kimi": "moonshot/moonshot-v1-auto",
  };

  return aliasMap[modelId] || modelId;
}
