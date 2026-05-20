/**
 * Pull an Ollama model in the background.
 *
 *   POST /api/memory/ollama/pull   { model }
 *     → starts the pull, returns { id }
 *   GET  /api/memory/ollama/pull?id=<id>
 *     → progress: { status, completed, total, percent, error? }
 *
 * Background-only — POST returns immediately so the UI can poll.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { pullModel } from "@/lib/ollama-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PullState {
  id: string;
  model: string;
  status: "running" | "ok" | "fail";
  completed: number;
  total: number;
  message: string;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

const runs = new Map<string, PullState>();

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) {
    return NextResponse.json({ error: "Missing model" }, { status: 400 });
  }

  const id = randomUUID();
  const state: PullState = {
    id,
    model,
    status: "running",
    completed: 0,
    total: 0,
    message: "starting",
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  runs.set(id, state);

  // Fire-and-forget; the UI polls GET ?id=
  pullModel(model, (event) => {
    state.message = event.status || state.message;
    if (typeof event.total === "number") state.total = event.total;
    if (typeof event.completed === "number") state.completed = event.completed;
  })
    .then(() => {
      state.status = "ok";
      state.finishedAt = Date.now();
    })
    .catch((err) => {
      state.status = "fail";
      state.error = err instanceof Error ? err.message : String(err);
      state.finishedAt = Date.now();
    });

  return NextResponse.json({ id, model });
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  const state = runs.get(id);
  if (!state) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const percent =
    state.total > 0 ? Math.min(100, (state.completed / state.total) * 100) : 0;
  return NextResponse.json({
    id: state.id,
    model: state.model,
    status: state.status,
    completed: state.completed,
    total: state.total,
    percent,
    message: state.message,
    error: state.error,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  });
}
