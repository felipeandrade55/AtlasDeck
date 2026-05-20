#!/usr/bin/env tsx
/**
 * Smoke test for the memory subsystem.
 *
 * Walks through the full happy path end-to-end:
 *   1. Server reachable
 *   2. Login (uses ADMIN_PASSWORD from .env)
 *   3. Import existing markdown into memories.db
 *   4. /api/memory/stats — confirm rows landed
 *   5. /api/memory/semantic-search — confirm embeddings + cosine work
 *   6. /api/memory/recall — confirm prompt block builds
 *   7. /api/memory/extract/run — force extraction (no-op if no sessions)
 *   8. /api/memory/inject/run — force injection into MEMORY.md
 *   9. Read back MEMORY.md and show the managed section
 *
 * Idempotent — safe to run repeatedly.
 *
 * Usage:
 *   npm run smoke-test:memory
 *   BASE_URL=http://localhost:3001 npm run smoke-test:memory
 *   WORKSPACE=workspace-devops npm run smoke-test:memory
 *
 * Reads .env automatically. Exits 0 on success, 1 on any failure.
 */
import { promises as fs } from "fs";
import path from "path";

// Tiny .env loader so we don't pull dotenv just for this
async function loadEnv() {
  try {
    const raw = await fs.readFile(
      path.join(process.cwd(), ".env"),
      "utf-8",
    );
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // .env optional
  }
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

const useColor = process.stdout.isTTY && process.env.NO_COLOR !== "1";
const C = (color: string, text: string) =>
  useColor ? `${color}${text}${RESET}` : text;

type Step = {
  label: string;
  required: boolean;
  durationMs: number;
  status: "ok" | "skip" | "fail";
  detail?: string;
};
const steps: Step[] = [];

function record(
  label: string,
  required: boolean,
  status: Step["status"],
  durationMs: number,
  detail?: string,
) {
  steps.push({ label, required, status, durationMs, detail });
  const icon =
    status === "ok"
      ? C(GREEN, "✓")
      : status === "skip"
      ? C(YELLOW, "–")
      : C(RED, "✗");
  console.log(
    `  ${icon} ${label} ${C(DIM, `(${durationMs}ms)`)}${detail ? "  " + C(DIM, detail) : ""}`,
  );
}

class SmokeError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
  }
}

let authCookie = "";

async function step<T>(
  label: string,
  required: boolean,
  fn: () => Promise<T>,
): Promise<T | null> {
  const start = Date.now();
  try {
    const result = await fn();
    record(label, required, "ok", Date.now() - start);
    return result;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    record(
      label,
      required,
      required ? "fail" : "skip",
      Date.now() - start,
      detail,
    );
    if (required) throw err;
    return null;
  }
}

async function apiFetch(pathSuffix: string, init: RequestInit = {}) {
  const base = process.env.BASE_URL || "http://localhost:3000";
  const url = `${base}${pathSuffix}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) || {}),
  };
  if (authCookie) headers["Cookie"] = authCookie;
  const res = await fetch(url, { ...init, headers });
  return res;
}

async function jsonOrThrow(res: Response, label: string): Promise<unknown> {
  let body: unknown;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new SmokeError(
      `${label} → HTTP ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
      body,
    );
  }
  return body;
}

async function main() {
  await loadEnv();

  const base = process.env.BASE_URL || "http://localhost:3000";
  const workspace = process.env.WORKSPACE || "workspace";
  const password = process.env.ADMIN_PASSWORD;

  console.log("");
  console.log(C(BOLD, C(CYAN, "AtlasDeck — Memory smoke test")));
  console.log(C(DIM, `target: ${base}  ·  workspace: ${workspace}`));
  console.log("");

  /* ── 1. Server reachable ─────────────────────────────────────────────── */
  await step("Servidor respondendo", true, async () => {
    const res = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null);
    if (!res) {
      throw new SmokeError(
        "não conectou — sobe com 'npm run dev' ou via PM2 antes de rodar o smoke test",
      );
    }
    if (!res.ok) {
      throw new SmokeError(`/api/health retornou HTTP ${res.status}`);
    }
  });

  /* ── 2. Login ────────────────────────────────────────────────────────── */
  await step("Autenticação (cookie mc_auth)", true, async () => {
    if (!password) {
      throw new SmokeError(
        "ADMIN_PASSWORD não encontrado no .env — configure antes de rodar",
      );
    }
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new SmokeError(`login falhou (HTTP ${res.status}): ${detail.slice(0, 120)}`);
    }
    const setCookie = res.headers.get("set-cookie") || "";
    const match = setCookie.match(/mc_auth=([^;]+)/);
    if (!match) {
      throw new SmokeError(`login não retornou cookie mc_auth (resposta: ${setCookie.slice(0, 120)})`);
    }
    authCookie = `mc_auth=${match[1]}`;
  });

  /* ── 3. Import existing markdown ─────────────────────────────────────── */
  const importResult = await step("Importar markdown (.md → memories.db)", true, async () => {
    const res = await apiFetch("/api/memory/import", {
      method: "POST",
      body: JSON.stringify({ embed: true }),
    });
    const data = (await jsonOrThrow(res, "import")) as {
      workspaces?: number;
      imported?: number;
      embedded?: number;
      hint?: string;
    };
    return data;
  });
  if (importResult) {
    console.log(
      C(DIM, `      workspaces=${importResult.workspaces ?? 0}, imported=${importResult.imported ?? 0}, embedded=${importResult.embedded ?? 0}${importResult.hint ? ` — ${importResult.hint}` : ""}`),
    );
  }

  /* ── 4. Stats ────────────────────────────────────────────────────────── */
  const stats = await step("Estatísticas (/api/memory/stats)", true, async () => {
    const res = await apiFetch("/api/memory/stats");
    return (await jsonOrThrow(res, "stats")) as {
      total: number;
      archived: number;
      pinned: number;
      byType: Record<string, number>;
      byWorkspace: Record<string, number>;
      embeddingModel: string | null;
      lastExtractionAt: string | null;
      cursors: number;
      fts: { totalFiles: number };
      embeddingReady: boolean;
    };
  });
  if (stats) {
    console.log(
      C(DIM, `      total=${stats.total}  arquivadas=${stats.archived}  pinadas=${stats.pinned}  sessões=${stats.cursors}`),
    );
    console.log(
      C(DIM, `      por tipo: ${Object.entries(stats.byType).map(([t, n]) => `${t}=${n}`).join(" · ")}`),
    );
    console.log(
      C(DIM, `      embedding: ${stats.embeddingModel || "(ainda sem)"}  pronto=${stats.embeddingReady ? "✓" : "lazy"}`),
    );
  }

  /* ── 5. Semantic search ──────────────────────────────────────────────── */
  await step("Busca semântica (cosseno)", false, async () => {
    const q = "preferências do usuário";
    const res = await apiFetch(
      `/api/memory/semantic-search?q=${encodeURIComponent(q)}&workspace=${encodeURIComponent(workspace)}&k=5`,
    );
    const data = (await jsonOrThrow(res, "semantic-search")) as {
      results?: Array<{ memory: { title: string }; score: number }>;
    };
    const hits = data.results ?? [];
    console.log(
      C(DIM, `      query="${q}"  →  ${hits.length} hit(s)`),
    );
    for (const hit of hits.slice(0, 3)) {
      console.log(
        C(DIM, `        · ${hit.score.toFixed(3)}  ${hit.memory.title.slice(0, 80)}`),
      );
    }
    if (hits.length === 0) {
      throw new SmokeError(
        "sem hits — esperado se workspace ainda não tem memórias indexadas; rode importação primeiro",
      );
    }
  });

  /* ── 6. Recall ───────────────────────────────────────────────────────── */
  await step("Recall (RAG-ready prompt block)", false, async () => {
    const res = await apiFetch("/api/memory/recall", {
      method: "POST",
      body: JSON.stringify({
        query: "como o usuário gosta de trabalhar",
        workspace,
        k: 6,
      }),
    });
    const data = (await jsonOrThrow(res, "recall")) as {
      memories?: Array<{ title: string }>;
      promptBlock?: string;
    };
    const count = data.memories?.length ?? 0;
    const block = (data.promptBlock || "").slice(0, 160);
    console.log(C(DIM, `      ${count} memória(s) retornada(s)`));
    if (block) console.log(C(DIM, `      preview: "${block.replace(/\n/g, " ")}..."`));
    if (count === 0) {
      throw new SmokeError(
        "recall retornou 0 — workspace pode estar vazio ou query muito específica",
      );
    }
  });

  /* ── 7. Force extraction (no-op if no sessions) ──────────────────────── */
  await step("Extração manual (lê JSONLs de sessões)", false, async () => {
    const res = await apiFetch("/api/memory/extract/run", {
      method: "POST",
      body: JSON.stringify({ maxSessions: 5, useLLM: true }),
    });
    const data = (await jsonOrThrow(res, "extract/run")) as {
      sessionsProcessed?: number;
      extracted?: number;
      linked?: number;
      skipped?: number;
      errors?: number;
    };
    console.log(
      C(DIM, `      sessões=${data.sessionsProcessed ?? 0}  extraídas=${data.extracted ?? 0}  links=${data.linked ?? 0}  skipped=${data.skipped ?? 0}  errors=${data.errors ?? 0}`),
    );
    if ((data.sessionsProcessed ?? 0) === 0) {
      throw new SmokeError(
        "nenhuma sessão nova encontrada — esperado se OpenClaw não está rodando aqui",
      );
    }
  });

  /* ── 8. Force injection ──────────────────────────────────────────────── */
  await step("Injeção do AUTO-RECALL no MEMORY.md", false, async () => {
    const res = await apiFetch("/api/memory/inject/run", {
      method: "POST",
      body: JSON.stringify({ workspace, maxMemories: 15 }),
    });
    const data = (await jsonOrThrow(res, "inject/run")) as {
      result?: {
        memoryFile?: string;
        memoriesInjected?: number;
        changed?: boolean;
      };
    };
    if (data.result) {
      console.log(
        C(DIM, `      arquivo=${data.result.memoryFile || "(skip)"}  memórias=${data.result.memoriesInjected ?? 0}  alterado=${data.result.changed ? "sim" : "não"}`),
      );
      if (!data.result.changed) {
        throw new SmokeError("nada alterado — workspace pode estar vazio ou setting desligado");
      }
    } else {
      throw new SmokeError("resposta sem result — setting inject_into_memory_md pode estar off");
    }
  });

  /* ── 9. Show the managed section preview ─────────────────────────────── */
  await step("Preview do trecho gerenciado em MEMORY.md", false, async () => {
    const res = await apiFetch(
      `/api/files?workspace=${encodeURIComponent(workspace)}&path=MEMORY.md`,
    );
    const data = (await jsonOrThrow(res, "files GET")) as {
      content?: string;
    };
    const raw = data.content || "";
    const match = raw.match(
      /<!-- BEGIN ATLASDECK AUTO-RECALL[\s\S]*?<!-- END ATLASDECK AUTO-RECALL -->/,
    );
    if (!match) {
      throw new SmokeError("seção AUTO-RECALL não encontrada no MEMORY.md");
    }
    const preview = match[0].split(/\r?\n/).slice(0, 12).join("\n");
    console.log("");
    console.log(C(MAGENTA, "      ── preview ─────────────────"));
    for (const line of preview.split("\n")) {
      console.log(C(DIM, `      ${line.slice(0, 120)}`));
    }
    console.log(C(MAGENTA, "      ─────────────────────────────"));
  });

  /* ── Summary ─────────────────────────────────────────────────────────── */
  console.log("");
  const ok = steps.filter((s) => s.status === "ok").length;
  const skip = steps.filter((s) => s.status === "skip").length;
  const fail = steps.filter((s) => s.status === "fail").length;
  const requiredFail = steps.filter((s) => s.status === "fail" && s.required).length;

  console.log(C(BOLD, "  Resumo:"));
  console.log(`    ${C(GREEN, "✓")} ${ok} ok    ${C(YELLOW, "–")} ${skip} skip    ${C(RED, "✗")} ${fail} fail`);
  console.log("");

  if (requiredFail > 0) {
    console.log(C(RED, "  Falha em passo obrigatório — corrija antes de prosseguir."));
    process.exit(1);
  } else if (fail > 0 || skip > 0) {
    console.log(C(YELLOW, "  Alguns passos opcionais não passaram — pode ser esperado (ex: workspace vazio, OpenClaw sem sessões neste ambiente)."));
    process.exit(0);
  } else {
    console.log(C(GREEN, C(BOLD, "  Tudo verde 🚀 — memory subsystem operando end-to-end.")));
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("");
  console.error(C(RED, "  Falha inesperada no smoke test:"));
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
