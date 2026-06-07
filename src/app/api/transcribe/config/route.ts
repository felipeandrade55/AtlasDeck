/**
 * Transcription analysis provider config.
 * GET  → current provider + chosen Ollama model + live Ollama status (models).
 * POST → { provider: "openai" | "ollama", ollama_model?: string }
 *
 * Lets the transcriptions page pick whether analysis runs on the (paid) OpenAI
 * API or fully local via Ollama, and which local model to use.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSettings, setSettings, type TranscriptionProvider } from "@/lib/memory-db";
import { getOllamaStatus } from "@/lib/ollama-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const settings = getSettings();
  let ollama: {
    installed: boolean;
    running: boolean;
    models: Array<{ name: string; size: number }>;
  } = { installed: false, running: false, models: [] };
  try {
    const status = await getOllamaStatus();
    ollama = {
      installed: status.installed,
      running: status.running,
      models: status.models.map((m) => ({ name: m.name, size: m.size })),
    };
  } catch {
    // Ollama unreachable — return defaults; UI will show "not running".
  }
  return NextResponse.json({
    provider: settings.transcription_provider,
    ollama_model: settings.ollama_model,
    openai_configured: !!process.env.OPENAI_API_KEY,
    ollama,
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const patch: { transcription_provider?: TranscriptionProvider; ollama_model?: string } = {};

  if (body.provider === "openai" || body.provider === "ollama") {
    patch.transcription_provider = body.provider;
  }
  if (typeof body.ollama_model === "string" && body.ollama_model.trim()) {
    patch.ollama_model = body.ollama_model.trim();
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nada para atualizar" }, { status: 400 });
  }

  const updated = setSettings(patch);
  return NextResponse.json({
    provider: updated.transcription_provider,
    ollama_model: updated.ollama_model,
  });
}
