/**
 * One-shot import: seeds the memories table from existing markdown
 * files in OpenClaw workspaces. Idempotent thanks to the unique key
 * on (workspace, source, source_file_path, title).
 *
 * POST /api/memory/import
 * Body (optional): { workspace? (defaults to all), dryRun? }
 */
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import {
  upsertMemory,
  setMemoryEmbedding,
  type MemoryType,
} from "@/lib/memory-db";
import { embedTexts } from "@/lib/embeddings";
import { ROOT_FILES, MEMORY_DIR, extractTitle } from "@/lib/memory-files";
import { resolveWorkspacePath } from "@/lib/workspace-resolver";
import { getOpenClawDir } from "@/lib/openclaw-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROOT_TYPE_MAP: Record<string, MemoryType> = {
  "MEMORY.md": "semantic",
  "SOUL.md": "identity",
  "USER.md": "semantic",
  "AGENTS.md": "semantic",
  "TOOLS.md": "procedural",
  "IDENTITY.md": "identity",
  "HEARTBEAT.md": "episodic",
};

interface CandidateSection {
  title: string;
  content: string;
}

function splitMarkdownSections(
  raw: string,
  fallbackTitle: string,
): CandidateSection[] {
  // Strip ATLASDECK auto-managed regions — we never want to re-import them.
  const cleaned = raw.replace(
    /<!-- BEGIN ATLASDECK AUTO-RECALL[\s\S]*?<!-- END ATLASDECK AUTO-RECALL -->/g,
    "",
  );

  const lines = cleaned.split(/\r?\n/);
  const sections: CandidateSection[] = [];
  let currentTitle: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join("\n").trim();
    if (content.length < 30) return;
    sections.push({
      title: currentTitle || fallbackTitle,
      content: content.slice(0, 3500),
    });
  };

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      flush();
      currentTitle = headingMatch[1].trim().slice(0, 200);
      buffer = [];
      continue;
    }
    if (currentTitle === null && line.startsWith("# ")) {
      // skip H1 — handled as fallback title
      continue;
    }
    buffer.push(line);
  }
  flush();

  if (sections.length === 0) {
    const content = cleaned.trim();
    if (content.length >= 30) {
      sections.push({
        title: fallbackTitle,
        content: content.slice(0, 3500),
      });
    }
  }

  return sections;
}

async function listWorkspaces(): Promise<string[]> {
  const openclawDir = getOpenClawDir();
  const out: string[] = [];
  try {
    const entries = await fs.readdir(openclawDir, { withFileTypes: true });
    if (entries.some((e) => e.isDirectory() && e.name === "workspace")) {
      out.push("workspace");
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name.startsWith("workspace-")) out.push(e.name);
    }
  } catch {
    // openclaw dir not present yet
  }
  return out;
}

async function gatherFiles(
  workspacePath: string,
): Promise<Array<{ rel: string; abs: string }>> {
  const out: Array<{ rel: string; abs: string }> = [];
  for (const root of ROOT_FILES) {
    const abs = path.join(workspacePath, root);
    try {
      const stat = await fs.stat(abs);
      if (stat.isFile()) out.push({ rel: root, abs });
    } catch {}
  }
  const memDir = path.join(workspacePath, MEMORY_DIR);
  try {
    const entries = await fs.readdir(memDir);
    for (const f of entries) {
      if (!f.endsWith(".md")) continue;
      out.push({ rel: `${MEMORY_DIR}/${f}`, abs: path.join(memDir, f) });
    }
  } catch {}
  return out;
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // body is optional
  }
  const workspaceFilter =
    typeof body.workspace === "string" ? body.workspace : null;
  const dryRun = Boolean(body.dryRun);
  const embed = body.embed === undefined ? true : Boolean(body.embed);

  const workspaces = workspaceFilter
    ? [workspaceFilter]
    : await listWorkspaces();

  if (workspaces.length === 0) {
    return NextResponse.json({
      success: true,
      workspaces: 0,
      imported: 0,
      embedded: 0,
      hint: "No workspaces detected under OPENCLAW_DIR yet.",
    });
  }

  let imported = 0;
  let embedded = 0;
  let workspacesProcessed = 0;
  const details: Array<{ workspace: string; files: number; sections: number }> = [];

  for (const ws of workspaces) {
    const wsPath = resolveWorkspacePath(ws);
    if (!wsPath) continue;
    try {
      await fs.access(wsPath);
    } catch {
      continue;
    }
    workspacesProcessed++;

    const files = await gatherFiles(wsPath);
    let sectionCount = 0;

    for (const file of files) {
      let raw: string;
      try {
        raw = await fs.readFile(file.abs, "utf-8");
      } catch {
        continue;
      }

      const basename = path.basename(file.rel);
      const inferredType: MemoryType =
        ROOT_TYPE_MAP[basename] ??
        (file.rel.startsWith(`${MEMORY_DIR}/`) ? "episodic" : "semantic");

      const fallbackTitle = extractTitle(raw, basename);
      const sections = splitMarkdownSections(raw, fallbackTitle);
      sectionCount += sections.length;

      if (dryRun) continue;

      for (const section of sections) {
        try {
          const mem = upsertMemory({
            workspace: ws,
            type: inferredType,
            title: section.title,
            content: section.content,
            summary: section.content
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 200),
            source: "import",
            source_file_path: file.rel,
            importance: inferredType === "identity" ? 0.8 : 0.5,
          });
          imported++;

          if (embed) {
            try {
              const { vectors, provider } = await embedTexts([
                `${section.title}\n${section.content}`,
              ]);
              setMemoryEmbedding(
                mem.id,
                vectors[0],
                `${provider.id}:${provider.modelId}`,
                provider.dim,
              );
              embedded++;
            } catch (err) {
              if (process.env.MEMORY_DEBUG === "1") {
                console.warn("[memory/import] embed failed:", err);
              }
            }
          }
        } catch (err) {
          if (process.env.MEMORY_DEBUG === "1") {
            console.warn("[memory/import] upsert failed:", err);
          }
        }
      }
    }

    details.push({ workspace: ws, files: files.length, sections: sectionCount });
  }

  return NextResponse.json({
    success: true,
    dryRun,
    workspaces: workspacesProcessed,
    imported,
    embedded,
    details,
  });
}
