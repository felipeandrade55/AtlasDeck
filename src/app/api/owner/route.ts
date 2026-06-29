/**
 * GET /api/owner — the owner's display name for the top bar.
 *
 * Resolution order:
 *   1. memory_settings.owner_name (set during Telegram pairing)
 *   2. parsed from the interview files (IDENTITY.md "## Owner",
 *      then USER.md "## Sobre mim") in the OpenClaw workspace
 *   3. null → the UI falls back to NEXT_PUBLIC_OWNER_NAME / "Usuário"
 *
 * Runtime (not build-time) so a fresh install greets the real person as
 * soon as they finish the wizard, with no rebuild.
 */
import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { getSettings } from "@/lib/memory-db";
import { getOpenClawWorkspace } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

/** Pull a person's name from a markdown section's first content line. */
function nameFromMarkdown(workspace: string): string | null {
  const tryFile = (file: string, heading: RegExp): string | null => {
    let text: string;
    try {
      text = readFileSync(join(workspace, file), "utf-8");
    } catch {
      return null;
    }
    const lines = text.split("\n");
    const idx = lines.findIndex((l) => heading.test(l.trim()));
    if (idx === -1) return null;
    for (let i = idx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.startsWith("#")) break; // hit the next section
      // "Felipe Andrade, programador…" → the name before a comma/period.
      const name = line
        .replace(/^[-*>]\s*/, "")
        .replace(/\*\*/g, "")
        .split(/[,.;–—|(]/)[0]
        .trim();
      if (name && name.length >= 2 && name.length <= 60 && !/não informado/i.test(name)) {
        return name;
      }
      return null;
    }
    return null;
  };
  return tryFile("IDENTITY.md", /^##\s*owner/i) ?? tryFile("USER.md", /^##\s*sobre mim/i);
}

export async function GET() {
  let name: string | null = null;
  try {
    name = getSettings().owner_name?.trim() || null;
  } catch {
    name = null;
  }
  if (!name) {
    try {
      name = nameFromMarkdown(getOpenClawWorkspace());
    } catch {
      name = null;
    }
  }
  return NextResponse.json({ name: name || null });
}
