/**
 * Memory injection: writes a managed "Auto-Recall" section into each
 * workspace's MEMORY.md so the agent has the memory guidance plus a
 * snapshot of its most important memories at session boot.
 *
 * This is the static baseline. Per-turn relevance (memories related to
 * the message being answered) is delivered separately by the turn-context
 * path, so this block stays small: guidance + top memories with a short
 * excerpt of their content.
 *
 * Writes go through managed-markdown (per-file lock + atomic rename) —
 * the orchestrator injector writes another block in the same file.
 */
import path from "path";
import {
  listMemories,
  getSettings,
  type MemoryRow,
} from "@/lib/memory-db";
import { resolveWorkspacePath } from "@/lib/workspace-resolver";
import {
  getOpenClawWorkspace,
  getAgentWorkspacePath,
} from "@/lib/openclaw-config";
import { indexFile } from "@/lib/memory-fts";
import { buildPromptBlock } from "@/lib/memory-extractor";
import { renderMemoryGuidance } from "@/lib/memory-guidance";
import { updateManagedBlock } from "@/lib/managed-markdown";

export const AUTO_RECALL_BEGIN = "<!-- BEGIN ATLASDECK AUTO-RECALL — do not edit; this section regenerates -->";
export const AUTO_RECALL_END = "<!-- END ATLASDECK AUTO-RECALL -->";

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
  // Episodic memories age out of the boot snapshot fast; durable facts don't.
  const typePenalty = memory.type === "episodic" ? 0.15 : 0;
  return importance + accessBonus + recencyBonus - typePenalty;
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
    limit: max * 3,
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

function resolveMemoryFile(workspace: string): string | null {
  // "workspace" is the convention for the main agent; the real on-disk
  // path comes from openclaw.json resolved the way the gateway does
  // (HOME-relative), not from AtlasDeck's own config.
  let wsPath: string | null = null;
  if (workspace === "workspace") {
    wsPath = getAgentWorkspacePath("main") ?? getOpenClawWorkspace();
  } else if (workspace.startsWith("workspace-")) {
    const agentId = workspace.slice("workspace-".length);
    wsPath = getAgentWorkspacePath(agentId) ?? resolveWorkspacePath(workspace);
  } else {
    wsPath = resolveWorkspacePath(workspace);
  }
  return wsPath ? path.join(wsPath, "MEMORY.md") : null;
}

export async function injectIntoWorkspace(
  workspace: string,
  opts: InjectionOptions = {},
): Promise<InjectionResult> {
  const settings = getSettings();
  const memoryFile = settings.inject_into_memory_md ? resolveMemoryFile(workspace) : null;
  if (!memoryFile) {
    return { workspace, memoryFile: "", memoriesInjected: 0, bytesWritten: 0, changed: false };
  }

  const { block, memories } = await buildRecallBlock(workspace, opts);
  const recallPayload = block.trim()
    ? `## O que você já sabe (snapshot das memórias mais importantes)\n\n${block}`
    : "_(sem memórias ainda)_";
  // Guidance first: the directive comes before the data it operates on.
  const payload = `${renderMemoryGuidance()}\n${recallPayload}`;

  const result = await updateManagedBlock(
    memoryFile,
    AUTO_RECALL_BEGIN,
    AUTO_RECALL_END,
    () =>
      `${AUTO_RECALL_BEGIN}\n## Auto-Recall (managed by AtlasDeck)\n_Atualizado em ${new Date().toISOString()}_\n\n${payload}\n${AUTO_RECALL_END}`,
    { initialContent: "# MEMORY\n" },
  );

  if (result.changed) {
    // Keep FTS index in sync
    await indexFile(workspace, "MEMORY.md", memoryFile).catch(() => undefined);
  }

  return {
    workspace,
    memoryFile,
    memoriesInjected: memories.length,
    bytesWritten: result.bytes,
    changed: result.changed,
  };
}

/**
 * Inject across every workspace that has at least one memory PLUS
 * the canonical "workspace" (main agent). We always touch "workspace"
 * because the injected block also carries the memory guidance.
 */
export async function injectAllWorkspaces(
  opts: InjectionOptions = {},
): Promise<InjectionResult[]> {
  const { byWorkspace } = (await import("@/lib/memory-db")).getStats();
  const targets = new Set<string>(Object.keys(byWorkspace));
  targets.add("workspace");
  const results: InjectionResult[] = [];
  for (const workspace of targets) {
    try {
      results.push(await injectIntoWorkspace(workspace, opts));
    } catch (err) {
      console.warn("[memory-injector] failed for", workspace, err instanceof Error ? err.message : err);
    }
  }
  return results;
}
