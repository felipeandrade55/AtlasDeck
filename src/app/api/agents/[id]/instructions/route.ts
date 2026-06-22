import { NextRequest, NextResponse } from "next/server";
import {
  previewInstructions,
  applyInstructions,
} from "@/lib/agent-instruction-files";
import { indexFile } from "@/lib/memory-fts";
import path from "path";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/agents/[id]/instructions
 * Returns the current managed instruction files (AGENTS/SOUL/TOOLS), the
 * channel context detected from openclaw.json, and a preview of what the
 * regenerated "base" block would look like (so the UI can show a diff and
 * token delta WITHOUT writing anything).
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const preview = await previewInstructions(id);
    if (!preview) {
      return NextResponse.json(
        { error: `Agente "${id}" não encontrado ou sem workspace no openclaw.json` },
        { status: 404 },
      );
    }
    return NextResponse.json(preview);
  } catch (error) {
    console.error("[agents/instructions] GET error:", error);
    return NextResponse.json(
      { error: "Falha ao ler os arquivos de instrução" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/agents/[id]/instructions
 * Body: { action: "preview" | "apply" }
 *  - "preview": same as GET (explicit, for symmetry with apply).
 *  - "apply":   backs up changed files into <workspace>/.atlasdeck-bak-<ts>/
 *               then writes the regenerated base block, preserving custom
 *               content outside the markers.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      action?: "preview" | "apply";
    };
    const action = body.action ?? "preview";

    if (action === "preview") {
      const preview = await previewInstructions(id);
      if (!preview) {
        return NextResponse.json(
          { error: `Agente "${id}" não encontrado ou sem workspace` },
          { status: 404 },
        );
      }
      return NextResponse.json(preview);
    }

    if (action === "apply") {
      const result = await applyInstructions(id);
      if (!result) {
        return NextResponse.json(
          { error: `Agente "${id}" não encontrado ou sem workspace` },
          { status: 404 },
        );
      }
      // Keep the FTS index in sync for the files we rewrote. Workspace id for
      // the index mirrors the agent id; errors are swallowed inside indexFile.
      for (const file of result.written) {
        await indexFile(id, file, path.join(result.workspace, file));
      }
      return NextResponse.json({ success: true, ...result });
    }

    return NextResponse.json(
      { error: `Ação desconhecida: ${action}` },
      { status: 400 },
    );
  } catch (error) {
    console.error("[agents/instructions] POST error:", error);
    return NextResponse.json(
      { error: "Falha ao aplicar os arquivos de instrução" },
      { status: 500 },
    );
  }
}
