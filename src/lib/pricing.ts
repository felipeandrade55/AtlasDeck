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
  // Legacy GPT-4 models (just in case of old data)
  {
    id: "openai/gpt-4-turbo",
    name: "GPT-4 Turbo",
    alias: "gpt-4-turbo",
    inputPricePerMillion: 10.00,
    outputPricePerMillion: 30.00,
    contextWindow: 128000,
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    alias: "gpt-4o",
    inputPricePerMillion: 5.00,
    outputPricePerMillion: 15.00,
    contextWindow: 128000,
  },
];

/**
 * Calculate cost for a given model and token usage
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = MODEL_PRICING.find(
    (p) => p.id === modelId || p.alias === modelId
  );

  if (!pricing) {
    console.warn(`Unknown model: ${modelId}, using default pricing`);
    // Default to GPT-5.4 pricing if unknown
    return (
      (inputTokens / 1_000_000) * 5.0 + (outputTokens / 1_000_000) * 15.0
    );
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPricePerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPricePerMillion;

  return inputCost + outputCost;
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
  };

  return aliasMap[modelId] || modelId;
}
