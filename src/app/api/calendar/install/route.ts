import { NextRequest, NextResponse } from "next/server";
import { getInstallStatus, runInstall } from "@/lib/calendar-installer";
import { addNotification, loadNotifications } from "@/lib/notifications";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROMPT_KIND = "calendar-install-prompt";
const PROMPT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

async function maybePostPendingNotification(failingCount: number) {
  if (failingCount === 0) return;
  try {
    const existing = await loadNotifications();
    const recent = existing.find(
      (n) =>
        (n.metadata as Record<string, unknown> | undefined)?.kind === PROMPT_KIND &&
        !n.read &&
        Date.now() - new Date(n.timestamp).getTime() < PROMPT_COOLDOWN_MS
    );
    if (recent) return;
    await addNotification(
      "⚠️ Integração do calendário pendente",
      `${failingCount} passo${failingCount > 1 ? "s" : ""} para o OpenClaw conseguir mexer no seu calendário. Abra /calendar e clique em "Instalar agora".`,
      "warning",
      "/calendar",
      { kind: PROMPT_KIND }
    );
  } catch (err) {
    console.error("Failed to post pending notification:", err);
  }
}

export async function GET(_request: NextRequest) {
  try {
    const report = getInstallStatus();
    const failing = report.steps.filter((s) => s.status !== "ok").length;
    void maybePostPendingNotification(failing);
    return NextResponse.json(report);
  } catch (error) {
    console.error("Failed to check install status:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function POST(_request: NextRequest) {
  try {
    const report = runInstall();
    const ok = report.ready;
    void addNotification(
      ok ? "✅ Calendário integrado ao OpenClaw" : "⚠️ Instalação do calendário concluída com pendências",
      ok
        ? "Todos os componentes estão prontos. Reinicie o AtlasDeck se a primeira instalação gerou um novo token."
        : "Alguns passos precisam de atenção. Abra /calendar para detalhes.",
      ok ? "success" : "warning",
      "/calendar",
      { kind: "calendar-install-result" }
    );
    return NextResponse.json(report);
  } catch (error) {
    console.error("Install failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
