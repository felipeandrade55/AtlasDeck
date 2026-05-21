/**
 * Wizard save step: writes the (possibly edited) IDENTITY.md /
 * SOUL.md / USER.md into the chosen workspace, after backing up the
 * existing files. Then triggers a reindex + import so the new content
 * shows up in semantic search immediately.
 *
 * POST /api/memory/wizard/save
 * Body: { workspace, files: { "IDENTITY.md": "...", ... } }
 */
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { resolveWorkspacePath } from "@/lib/workspace-resolver";
import { ROOT_FILES, sanitizeWorkspaceRelativePath } from "@/lib/memory-files";
import { indexFile } from "@/lib/memory-fts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TARGETS: ReadonlySet<string> = new Set([
  "IDENTITY.md",
  "SOUL.md",
  "USER.md",
]);

export async function POST(request: NextRequest) {
  let body: { workspace?: string; files?: Record<string, string> };
  try {
    body = (await request.json()) as { workspace?: string; files?: Record<string, string> };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const workspace = body.workspace || "workspace";
  const files = body.files || {};
  const filteredKeys = Object.keys(files).filter((k) => ALLOWED_TARGETS.has(k));
  if (filteredKeys.length === 0) {
    return NextResponse.json(
      { error: "Nenhum arquivo válido fornecido (esperado IDENTITY.md, SOUL.md ou USER.md)" },
      { status: 400 },
    );
  }

  const wsPath = resolveWorkspacePath(workspace);
  if (!wsPath) {
    return NextResponse.json({ error: "Workspace inválido" }, { status: 400 });
  }
  try {
    await fs.access(wsPath);
  } catch {
    return NextResponse.json({ error: "Workspace não encontrado no disco" }, { status: 404 });
  }

  const written: Array<{ file: string; backup: string | null; bytes: number }> = [];

  for (const key of filteredKeys) {
    const safe = sanitizeWorkspaceRelativePath(key);
    if (!safe) continue;
    if (!(ROOT_FILES as readonly string[]).includes(safe)) continue;

    const target = path.join(wsPath, safe);
    let backupPath: string | null = null;

    try {
      await fs.access(target);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = `${target}.bak.${ts}`;
      await fs.copyFile(target, backupPath);
    } catch {
      // file doesn't exist yet — no backup needed
    }

    const content = files[key];
    await fs.writeFile(target, content, "utf-8");
    await indexFile(workspace, safe, target);

    written.push({ file: safe, backup: backupPath, bytes: Buffer.byteLength(content, "utf-8") });
  }

  return NextResponse.json({
    success: true,
    workspace,
    written,
    hint:
      "Arquivos salvos. Para popular a memória semântica, rode 'Importar markdown existente' em Memória → Configurações.",
  });
}
