/**
 * In-app health check for the memory subsystem.
 *
 * Same shape as the CLI smoke test, but runnable from a button in the
 * UI — no need to SSH and run a shell script when reinstalling on a
 * new VPS. Returns a structured list of checks the UI can render.
 *
 * GET  /api/memory/health        → run all checks
 * POST /api/memory/health        → same as GET, kept for parity
 */
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getStats, type MemorySettings, getSettings, searchSimilar } from "@/lib/memory-db";
import { getIndexStats, searchMemoryFiles, syncWorkspace } from "@/lib/memory-fts";
import { isEmbeddingReady, embedTexts } from "@/lib/embeddings";
import { resolveWorkspacePath } from "@/lib/workspace-resolver";
import { getOllamaStatus } from "@/lib/ollama-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CheckResult {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail" | "skip";
  detail: string;
  durationMs: number;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, durationMs: Date.now() - start };
}

async function checkWorkspaces(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const wsPath = resolveWorkspacePath("workspace");
    if (!wsPath) {
      return {
        id: "workspaces",
        label: "Workspace acessível",
        status: "fail",
        detail: "Não foi possível resolver o path do workspace principal",
        durationMs: Date.now() - start,
      };
    }
    await fs.access(wsPath);
    return {
      id: "workspaces",
      label: "Workspace acessível",
      status: "ok",
      detail: wsPath,
      durationMs: Date.now() - start,
    };
  } catch {
    return {
      id: "workspaces",
      label: "Workspace acessível",
      status: "warn",
      detail: "Workspace principal não encontrado em disco — normal se ainda não rodou o OpenClaw",
      durationMs: Date.now() - start,
    };
  }
}

async function checkFtsIndex(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const stats = getIndexStats();
    if (stats.totalFiles === 0) {
      return {
        id: "fts",
        label: "Índice FTS5 inicializado",
        status: "warn",
        detail: "Índice vazio — rode 'Reindexar FTS' em Memória → Configurações depois de criar arquivos",
        durationMs: Date.now() - start,
      };
    }
    return {
      id: "fts",
      label: "Índice FTS5 inicializado",
      status: "ok",
      detail: `${stats.totalFiles} arquivo(s) indexado(s)`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id: "fts",
      label: "Índice FTS5 inicializado",
      status: "fail",
      detail: err instanceof Error ? err.message : "Falha desconhecida",
      durationMs: Date.now() - start,
    };
  }
}

async function checkMemoriesDB(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const stats = getStats();
    if (stats.total === 0) {
      return {
        id: "memories-db",
        label: "Memórias persistidas",
        status: "warn",
        detail: "Nenhuma memória ainda — rode 'Importar markdown' em Memória → Configurações",
        durationMs: Date.now() - start,
      };
    }
    return {
      id: "memories-db",
      label: "Memórias persistidas",
      status: "ok",
      detail: `${stats.total} memória(s) (ativas: ${stats.total - stats.archived})`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id: "memories-db",
      label: "Memórias persistidas",
      status: "fail",
      detail: err instanceof Error ? err.message : "Falha desconhecida",
      durationMs: Date.now() - start,
    };
  }
}

async function checkEmbeddings(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const ready = await isEmbeddingReady();
    if (!ready) {
      return {
        id: "embeddings",
        label: "Modelo de embedding pronto",
        status: "warn",
        detail: "Xenova carrega sob demanda no primeiro uso — rode 'npm run setup:memory' para pré-baixar",
        durationMs: Date.now() - start,
      };
    }
    // Quick functional test
    await embedTexts(["teste de embedding"]);
    return {
      id: "embeddings",
      label: "Modelo de embedding pronto",
      status: "ok",
      detail: "Xenova MiniLM-L6 respondeu em embedding-test",
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id: "embeddings",
      label: "Modelo de embedding pronto",
      status: "fail",
      detail: err instanceof Error ? err.message : "Falha desconhecida",
      durationMs: Date.now() - start,
    };
  }
}

async function checkSemanticSearch(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const ready = await isEmbeddingReady();
    if (!ready) {
      return {
        id: "semantic-search",
        label: "Busca semântica respondendo",
        status: "skip",
        detail: "embedding model ainda não está pronto",
        durationMs: Date.now() - start,
      };
    }
    const { vectors } = await embedTexts(["teste de busca"]);
    const hits = searchSimilar(vectors[0], { k: 3 });
    return {
      id: "semantic-search",
      label: "Busca semântica respondendo",
      status: "ok",
      detail: `${hits.length} hit(s) com a query de teste`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id: "semantic-search",
      label: "Busca semântica respondendo",
      status: "fail",
      detail: err instanceof Error ? err.message : "Falha desconhecida",
      durationMs: Date.now() - start,
    };
  }
}

async function checkKeywordSearch(workspace: string): Promise<CheckResult> {
  const start = Date.now();
  try {
    await syncWorkspace(workspace);
    const hits = searchMemoryFiles("memory", { workspace, limit: 3 });
    return {
      id: "keyword-search",
      label: "Busca por keyword (FTS5)",
      status: "ok",
      detail: `${hits.length} hit(s) com query 'memory'`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id: "keyword-search",
      label: "Busca por keyword (FTS5)",
      status: "fail",
      detail: err instanceof Error ? err.message : "Falha desconhecida",
      durationMs: Date.now() - start,
    };
  }
}

async function checkExtractor(settings: MemorySettings): Promise<CheckResult> {
  const start = Date.now();
  const provider = settings.extractor_provider;
  if (provider === "heuristic") {
    return {
      id: "extractor",
      label: "Extrator de memórias",
      status: "ok",
      detail: "Modo heurístico ativo — sem dependência externa",
      durationMs: Date.now() - start,
    };
  }
  if (provider === "ollama") {
    const status = await getOllamaStatus();
    if (!status.installed) {
      return {
        id: "extractor",
        label: "Extrator de memórias",
        status: "warn",
        detail: "Provider = Ollama mas Ollama não está instalado",
        durationMs: Date.now() - start,
      };
    }
    if (!status.running) {
      return {
        id: "extractor",
        label: "Extrator de memórias",
        status: "warn",
        detail: `Ollama instalado mas não está respondendo em ${status.baseUrl}`,
        durationMs: Date.now() - start,
      };
    }
    const hasModel = status.models.some(
      (m) => m.name === settings.ollama_model || m.name === `${settings.ollama_model}:latest`,
    );
    return {
      id: "extractor",
      label: "Extrator de memórias",
      status: hasModel ? "ok" : "warn",
      detail: hasModel
        ? `Ollama rodando com ${settings.ollama_model}`
        : `Ollama rodando mas modelo '${settings.ollama_model}' não está baixado`,
      durationMs: Date.now() - start,
    };
  }
  // OpenClaw
  return {
    id: "extractor",
    label: "Extrator de memórias",
    status: "ok",
    detail: "Provider = OpenClaw CLI (modelo configurado no seu OpenClaw)",
    durationMs: Date.now() - start,
  };
}

async function checkInjection(workspace: string): Promise<CheckResult> {
  const start = Date.now();
  const wsPath = resolveWorkspacePath(workspace);
  if (!wsPath) {
    return {
      id: "injection",
      label: "AUTO-RECALL no MEMORY.md",
      status: "skip",
      detail: "workspace inacessível",
      durationMs: Date.now() - start,
    };
  }
  try {
    const memoryFile = path.join(wsPath, "MEMORY.md");
    const raw = await fs.readFile(memoryFile, "utf-8").catch(() => "");
    if (raw.includes("BEGIN ATLASDECK AUTO-RECALL")) {
      return {
        id: "injection",
        label: "AUTO-RECALL no MEMORY.md",
        status: "ok",
        detail: "Bloco gerenciado presente — o agente recebe contexto no boot",
        durationMs: Date.now() - start,
      };
    }
    return {
      id: "injection",
      label: "AUTO-RECALL no MEMORY.md",
      status: "warn",
      detail: "Bloco AUTO-RECALL ainda não foi injetado — clique em 'Atualizar AUTO-RECALL' em Configurações",
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id: "injection",
      label: "AUTO-RECALL no MEMORY.md",
      status: "fail",
      detail: err instanceof Error ? err.message : "Falha desconhecida",
      durationMs: Date.now() - start,
    };
  }
}

async function runAllChecks(workspace: string): Promise<CheckResult[]> {
  const settings = getSettings();
  const checks = await Promise.all([
    checkWorkspaces(),
    checkFtsIndex(),
    checkMemoriesDB(),
    checkEmbeddings(),
    checkSemanticSearch(),
    checkKeywordSearch(workspace),
    checkExtractor(settings),
    checkInjection(workspace),
  ]);
  return checks;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const workspace = url.searchParams.get("workspace") || "workspace";
  const { result, durationMs } = await timed(() => runAllChecks(workspace));
  const summary = {
    ok: result.filter((c) => c.status === "ok").length,
    warn: result.filter((c) => c.status === "warn").length,
    fail: result.filter((c) => c.status === "fail").length,
    skip: result.filter((c) => c.status === "skip").length,
  };
  return NextResponse.json({
    checks: result,
    summary,
    durationMs,
    workspace,
  });
}

export async function POST(request: Request) {
  return GET(request);
}
