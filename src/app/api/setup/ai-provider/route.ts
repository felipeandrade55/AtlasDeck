/**
 * AI provider configuration for the welcome wizard.
 *
 *   POST /api/setup/ai-provider?action=test   { provider, apiKey }
 *     → cheap call to the provider to confirm the key is valid
 *
 *   POST /api/setup/ai-provider?action=save   { provider, modelId, apiKey? }
 *     → persists key (cloud) and writes first-agent model.primary; advances setup_step
 */
import { NextResponse } from "next/server";
import { readFileSync, writeFileSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import { setProviderKey, type ProviderId } from "@/lib/provider-keys";
import { setSettings } from "@/lib/memory-db";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

type CloudProvider = ProviderId;
type AnyProvider = CloudProvider | "ollama" | "openclaw-codex";

interface TestBody {
  provider: CloudProvider;
  apiKey: string;
}

interface SaveBody {
  provider: AnyProvider;
  modelId: string;
  apiKey?: string;
}

interface ConfigShape {
  agents?: {
    defaults?: { model?: { primary?: string } };
    list?: Array<{ id: string; model?: { primary?: string; fallback?: string } }>;
  };
}

const TIMEOUT_MS = 7000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function testCloudKey(
  provider: CloudProvider,
  apiKey: string,
): Promise<{ ok: boolean; sampleModels: string[]; error?: string }> {
  try {
    if (provider === "anthropic") {
      const res = await fetchWithTimeout("https://api.anthropic.com/v1/models?limit=5", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, sampleModels: [], error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      const json = (await res.json()) as { data?: Array<{ id: string }> };
      return { ok: true, sampleModels: (json.data ?? []).map((m) => m.id).slice(0, 5) };
    }
    if (provider === "openai") {
      const res = await fetchWithTimeout("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, sampleModels: [], error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      const json = (await res.json()) as { data?: Array<{ id: string }> };
      return { ok: true, sampleModels: (json.data ?? []).slice(0, 5).map((m) => m.id) };
    }
    if (provider === "google") {
      const res = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, sampleModels: [], error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      const json = (await res.json()) as { models?: Array<{ name?: string }> };
      const ids = (json.models ?? [])
        .map((m) => (m.name ?? "").replace(/^models\//, ""))
        .filter((x) => x.length > 0);
      return { ok: true, sampleModels: ids.slice(0, 5) };
    }
    return { ok: false, sampleModels: [], error: `Provider desconhecido: ${provider}` };
  } catch (err) {
    return { ok: false, sampleModels: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "save";

  let body: TestBody | SaveBody;
  try {
    body = (await req.json()) as TestBody | SaveBody;
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }

  if (action === "test") {
    const { provider, apiKey } = body as TestBody;
    if (!provider || !apiKey || !apiKey.trim()) {
      return NextResponse.json({ error: "provider e apiKey são obrigatórios" }, { status: 400 });
    }
    if (provider !== "anthropic" && provider !== "openai" && provider !== "google") {
      return NextResponse.json({ error: "test só funciona para anthropic/openai/google" }, { status: 400 });
    }
    const result = await testCloudKey(provider, apiKey.trim());
    return NextResponse.json(result);
  }

  if (action === "save") {
    const { provider, modelId, apiKey } = body as SaveBody;
    if (!provider || !modelId || !modelId.trim()) {
      return NextResponse.json({ error: "provider e modelId são obrigatórios" }, { status: 400 });
    }

    if (provider === "anthropic" || provider === "openai" || provider === "google") {
      if (!apiKey || !apiKey.trim()) {
        return NextResponse.json({ error: "apiKey obrigatória para providers cloud" }, { status: 400 });
      }
      setProviderKey(provider, apiKey.trim());
    }

    try {
      const { path: configPath } = resolveOpenClawAgentsConfigPath();
      const config = JSON.parse(readFileSync(configPath, "utf-8")) as ConfigShape;
      if (!config.agents) config.agents = {};
      if (!Array.isArray(config.agents.list) || config.agents.list.length === 0) {
        return NextResponse.json(
          { error: "Nenhum agente em agents.list — rode openclaw init antes" },
          { status: 500 },
        );
      }
      const first = config.agents.list[0];
      if (!first.model) first.model = {};
      first.model.primary = modelId.trim();
      // Mirror to defaults so new agents inherit too
      if (!config.agents.defaults) config.agents.defaults = {};
      if (!config.agents.defaults.model) config.agents.defaults.model = {};
      config.agents.defaults.model.primary = modelId.trim();
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    } catch (err) {
      return NextResponse.json(
        { error: `Falha ao gravar openclaw.json: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 },
      );
    }

    const settingsPatch: Parameters<typeof setSettings>[0] = {
      setup_step: "interview",
      llm_choice_made: true,
      extractor_provider: provider === "ollama" ? "ollama" : "openclaw",
    };
    if (provider === "ollama") {
      const trimmed = modelId.trim().replace(/^ollama\//, "");
      if (trimmed) settingsPatch.ollama_model = trimmed;
    }
    setSettings(settingsPatch);

    try {
      logActivity("config", `Modelo de IA configurado: ${modelId}`, "success", {
        metadata: { provider, modelId },
      });
    } catch {}

    return NextResponse.json({ success: true, provider, modelId });
  }

  return NextResponse.json(
    { error: `Ação desconhecida: "${action}". Use ?action=test ou ?action=save` },
    { status: 400 },
  );
}
