/**
 * Registry of known model identifiers usable in OpenClaw's `model.primary` /
 * `model.fallback` fields. Used by the UI to render dropdowns and by the API
 * to validate / warn before persisting bad values.
 *
 * NOT exhaustive — OpenClaw accepts any "provider/model" string. Custom values
 * are still allowed; the registry just provides curated suggestions and
 * detects well-known foot-guns (like `openai/gpt-5.5` literal, which is not
 * a valid OpenAI model name and silently fails to a fallback).
 */

export type ModelTier = "primary" | "balanced" | "fast" | "fallback" | "legacy";
export type ModelProvider = "openai" | "anthropic" | "ollama" | "google" | "custom";

export interface KnownModel {
  id: string;
  label: string;
  provider: ModelProvider;
  tier: ModelTier;
  notes?: string;
}

export const KNOWN_MODELS: KnownModel[] = [
  // OpenAI — current
  { id: "openai/gpt-5.5", label: "GPT-5.5 (via Codex OAuth)", provider: "openai", tier: "primary", notes: "Modelo padrão de quem fez `openclaw models auth login --provider openai-codex`" },
  { id: "openai/gpt-5.5-codex", label: "GPT-5.5 Codex (API)", provider: "openai", tier: "primary", notes: "Requer API key OpenAI direta (não funciona via Codex OAuth)" },
  { id: "openai/gpt-5.5-mini", label: "GPT-5.5 Mini", provider: "openai", tier: "fast", notes: "Mais barato, bom pra fallback" },
  { id: "openai/gpt-5.5-nano", label: "GPT-5.5 Nano", provider: "openai", tier: "fast" },

  // OpenAI — legacy (still funcionais mas defasados)
  { id: "openai/gpt-5.4-codex", label: "GPT-5.4 Codex", provider: "openai", tier: "legacy" },
  { id: "openai/gpt-5.4", label: "GPT-5.4", provider: "openai", tier: "legacy" },
  { id: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini", provider: "openai", tier: "legacy" },

  // Anthropic
  { id: "anthropic/claude-opus-4-7", label: "Claude Opus 4.7", provider: "anthropic", tier: "primary", notes: "Mais inteligente da Anthropic; mais caro" },
  { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic", tier: "balanced" },
  { id: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic", tier: "fast", notes: "Excelente para fallback (tool-use confiável)" },

  // Google
  { id: "google/gemini-2.0-flash", label: "Gemini 2.0 Flash", provider: "google", tier: "fast" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "google", tier: "balanced" },

  // Ollama (local — exige o modelo puxado no host com `ollama pull <id>`)
  { id: "ollama/qwen2.5-coder:14b", label: "Qwen 2.5 Coder 14B (local)", provider: "ollama", tier: "fallback", notes: "Local; precisa de `ollama pull qwen2.5-coder:14b`" },
  { id: "ollama/qwen2.5:14b", label: "Qwen 2.5 14B (local)", provider: "ollama", tier: "fallback" },
  { id: "ollama/qwen2.5:7b", label: "Qwen 2.5 7B (local)", provider: "ollama", tier: "fallback", notes: "Pequeno demais para tool-use confiável" },
  { id: "ollama/llama3.3:70b", label: "Llama 3.3 70B (local)", provider: "ollama", tier: "fallback", notes: "Requer GPU forte" },
];

/**
 * Patterns that are clearly invalid or known to silently fail. Used to surface
 * a warning in the UI before the user saves.
 */
export interface ModelWarning {
  level: "error" | "warning";
  message: string;
}

export function validateModelId(raw: string): ModelWarning | null {
  const id = raw.trim();
  if (!id) {
    return { level: "error", message: "Modelo não pode estar vazio." };
  }

  // Must be "provider/model"
  if (!id.includes("/")) {
    return { level: "error", message: 'Formato esperado: "provider/model" (ex: openai/gpt-5.5-codex).' };
  }

  const [provider, model] = id.split("/", 2);

  // `openai/gpt-5.5` puro é o nome do modelo via Codex OAuth (descoberto
  // empiricamente — não confundir com o legacy `openai/gpt-5.4` puro).
  // Versão anterior dessa função bloqueava esse id como "não existe", o que
  // estava errado e impedia o usuário de usar a auth correta via Codex.
  if (provider === "openai" && /^gpt-5\.4$/i.test(model)) {
    return {
      level: "warning",
      message: 'Modelo "openai/gpt-5.4" é legacy. Considere migrar para "openai/gpt-5.5-codex".',
    };
  }

  // Anthropic ID hyphen sanity
  if (provider === "anthropic" && !/^claude-/.test(model)) {
    return { level: "warning", message: 'Modelos Anthropic começam com "claude-" (ex: claude-sonnet-4-6).' };
  }

  // Ollama precisa de tag (após `:`)
  if (provider === "ollama" && !model.includes(":")) {
    return {
      level: "warning",
      message: `Modelos Ollama geralmente exigem tag (ex: "ollama/${model}:7b" ou ":latest").`,
    };
  }

  // Suggestion: small ollama models são frágeis pra fallback de agente com tool-use
  if (provider === "ollama" && /(:7b|:3b|:1\.5b|:1b)$/i.test(model)) {
    return {
      level: "warning",
      message: "Modelos pequenos do Ollama (≤7B) costumam falhar em tool-use de agentes — considere 14B+ ou usar Anthropic Haiku como fallback.",
    };
  }

  return null;
}

export function isKnownModel(id: string): boolean {
  return KNOWN_MODELS.some((m) => m.id === id);
}

export function findKnownModel(id: string): KnownModel | null {
  return KNOWN_MODELS.find((m) => m.id === id) || null;
}

export function detectProvider(id: string): ModelProvider {
  const prefix = id.split("/")[0]?.toLowerCase();
  if (prefix === "openai" || prefix === "anthropic" || prefix === "ollama" || prefix === "google") {
    return prefix;
  }
  return "custom";
}
