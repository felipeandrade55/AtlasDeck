/**
 * Memory injection: writes a managed "Auto-Recall" section directly
 * into each workspace's MEMORY.md so that the OpenClaw agent reads it
 * on session boot (OpenClaw already loads MEMORY.md as part of its
 * standard workspace context).
 *
 * The managed section is delimited by HTML comments. Anything outside
 * the markers is preserved verbatim — the user's hand-written content
 * is never overwritten.
 */
import { promises as fs } from "fs";
import path from "path";
import {
  listMemories,
  getSettings,
  type MemoryRow,
} from "@/lib/memory-db";
import { resolveWorkspacePath } from "@/lib/workspace-resolver";
import { indexFile } from "@/lib/memory-fts";
import { buildPromptBlock } from "@/lib/memory-extractor";

const BEGIN_MARK = "<!-- BEGIN ATLASDECK AUTO-RECALL — do not edit; this section regenerates -->";
const END_MARK = "<!-- END ATLASDECK AUTO-RECALL -->";

export interface InjectionOptions {
  maxMemories?: number;
  includePinned?: boolean;
  includeReflections?: boolean;
}

export interface InjectionResult {
  workspace: string;
  memoryFile: string;
  memoriesInjected: number;
  bytesWritten: number;
  changed: boolean;
}

function score(memory: MemoryRow): number {
  // Composite ranking: importance dominant, recency + access tiebreak
  const importance = memory.importance ?? 0;
  const accessBonus = Math.min(memory.access_count, 20) * 0.005;
  const recency = memory.last_accessed_at
    ? Date.parse(memory.last_accessed_at)
    : Date.parse(memory.created_at);
  const ageDays = Math.max(0, (Date.now() - recency) / (1000 * 60 * 60 * 24));
  const recencyBonus = Math.exp(-ageDays / 30) * 0.1;
  return importance + accessBonus + recencyBonus;
}

export async function buildRecallBlock(
  workspace: string,
  opts: InjectionOptions = {},
): Promise<{ block: string; memories: MemoryRow[] }> {
  const max = Math.min(Math.max(opts.maxMemories ?? 20, 1), 80);

  const { memories: pinned } = listMemories({
    workspace,
    pinned: true,
    archived: false,
    limit: max,
    sort: "importance",
  });

  const { memories: top } = listMemories({
    workspace,
    archived: false,
    limit: max * 2,
    sort: "importance",
  });

  const seen = new Set<string>();
  const merged: MemoryRow[] = [];
  for (const m of pinned) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push(m);
  }
  for (const m of top.sort((a, b) => score(b) - score(a))) {
    if (merged.length >= max) break;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push(m);
  }

  const block = buildPromptBlock(merged);
  return { block, memories: merged };
}

function spliceManagedSection(existing: string, payload: string): string {
  const beginIdx = existing.indexOf(BEGIN_MARK);
  const endIdx = existing.indexOf(END_MARK);

  const managedBlock = `${BEGIN_MARK}\n## Auto-Recall (managed by AtlasDeck)\n_Atualizado em ${new Date().toISOString()}_\n\n${payload}\n${END_MARK}`;

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx).trimEnd();
    const after = existing.slice(endIdx + END_MARK.length).trimStart();
    return [before, managedBlock, after].filter(Boolean).join("\n\n").trim() + "\n";
  }

  const base = existing.trimEnd();
  if (!base) return `${managedBlock}\n`;
  return `${base}\n\n${managedBlock}\n`;
}

export async function injectIntoWorkspace(
  workspace: string,
  opts: InjectionOptions = {},
): Promise<InjectionResult> {
  const settings = getSettings();
  if (!settings.inject_into_memory_md) {
    return {
      workspace,
      memoryFile: "",
      memoriesInjected: 0,
      bytesWritten: 0,
      changed: false,
    };
  }

  const wsPath = resolveWorkspacePath(workspace);
  if (!wsPath) {
    return {
      workspace,
      memoryFile: "",
      memoriesInjected: 0,
      bytesWritten: 0,
      changed: false,
    };
  }

  const memoryFile = path.join(wsPath, "MEMORY.md");

  let existing = "";
  try {
    existing = await fs.readFile(memoryFile, "utf-8");
  } catch {
    // MEMORY.md may not exist yet — that's fine, we'll create it
    existing = "# MEMORY\n";
  }

  const { block, memories } = await buildRecallBlock(workspace, opts);
  const payload = block.trim() ? block : "_(sem memórias relevantes ainda)_";
  const next = spliceManagedSection(existing, payload);

  if (next === existing) {
    return {
      workspace,
      memoryFile,
      memoriesInjected: memories.length,
      bytesWritten: 0,
      changed: false,
    };
  }

  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  await fs.writeFile(memoryFile, next, "utf-8");

  // Keep FTS index in sync
  await indexFile(workspace, "MEMORY.md", memoryFile);

  return {
    workspace,
    memoryFile,
    memoriesInjected: memories.length,
    bytesWritten: Buffer.byteLength(next, "utf-8"),
    changed: true,
  };
}

/**
 * Inject across every workspace that has at least one memory.
 */
export async function injectAllWorkspaces(
  opts: InjectionOptions = {},
): Promise<InjectionResult[]> {
  const { byWorkspace } = (await import("@/lib/memory-db")).getStats();
  const results: InjectionResult[] = [];
  for (const workspace of Object.keys(byWorkspace)) {
    try {
      results.push(await injectIntoWorkspace(workspace, opts));
    } catch (err) {
      if (process.env.MEMORY_DEBUG === "1") {
        console.warn("[memory-injector] failed for", workspace, err);
      }
    }
  }
  return results;
}
