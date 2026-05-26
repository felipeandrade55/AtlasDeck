import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

/**
 * Templates resolution order — first hit wins:
 *   1. `data/agent-templates.json`         — user override (gitignored)
 *   2. `data/agent-templates.example.json` — ships in the repo
 *
 * This matches the broader pattern in /.gitignore where /data/*.json is
 * private to the install and *.example.json is the seed that ships. Users
 * who want to customise templates can copy the .example over and edit.
 */
const TEMPLATES_OVERRIDE = path.join(process.cwd(), "data", "agent-templates.json");
const TEMPLATES_EXAMPLE = path.join(process.cwd(), "data", "agent-templates.example.json");

function resolveTemplatesPath(): string {
  return fs.existsSync(TEMPLATES_OVERRIDE) ? TEMPLATES_OVERRIDE : TEMPLATES_EXAMPLE;
}

export interface AgentTemplate {
  id: string;
  name: string;
  emoji: string;
  color: string;
  role: "orchestrator" | "specialist" | "reviewer";
  specialty: string[];
  inherit_jarvis_skills: boolean;
  suggested_model: string;
  suggested_fallback?: string;
  suggested_skills: string[];
  personality: string;
  system_prompt: string;
  default_cost_caps?: { per_task_cents?: number; per_day_cents?: number };
}

export async function GET() {
  try {
    const raw = fs.readFileSync(resolveTemplatesPath(), "utf-8");
    const parsed = JSON.parse(raw) as { version: number; templates: AgentTemplate[] };
    return NextResponse.json({
      version: parsed.version,
      templates: Array.isArray(parsed.templates) ? parsed.templates : [],
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message, templates: [] }, { status: 500 });
  }
}
