import { NextRequest, NextResponse } from "next/server";
import { getInstallStatus, runInstall } from "@/lib/calendar-installer";
import { addNotification, loadNotifications, saveNotifications } from "@/lib/notifications";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROMPT_KIND = "calendar-install-prompt";
const RESULT_KIND = "calendar-install-result";
const PROMPT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function isInstallNotificationKind(meta: unknown): boolean {
  const kind = (meta as Record<string, unknown> | undefined)?.kind;
  return kind === PROMPT_KIND || kind === RESULT_KIND;
}

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

async function cleanupInstallNotifications(keepLatestSuccessId?: string) {
  try {
    const existing = await loadNotifications();
    const filtered = existing.filter(
      (n) => !isInstallNotificationKind(n.metadata) || n.id === keepLatestSuccessId
    );
    if (filtered.length !== existing.length) {
      await saveNotifications(filtered);
    }
  } catch (err) {
    console.error("Failed to cleanup install notifications:", err);
  }
}

export async function GET(_request: NextRequest) {
  try {
    const report = getInstallStatus();
    const failing = report.steps.filter((s) => s.status !== "ok").length;
    if (failing === 0) {
      void cleanupInstallNotifications();
    } else {
      void maybePostPendingNotification(failing);
    }
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
    if (ok) {
      const created = await addNotification(
        "✅ Calendário integrado ao OpenClaw",
        "Todos os componentes estão prontos. Reinicie o AtlasDeck se a primeira instalação gerou um novo token.",
        "success",
        "/calendar",
        { kind: RESULT_KIND }
      );
      void cleanupInstallNotifications(created.id);
    } else {
      void addNotification(
        "⚠️ Instalação do calendário concluída com pendências",
        "Alguns passos precisam de atenção. Abra /calendar para detalhes.",
        "warning",
        "/calendar",
        { kind: RESULT_KIND }
      );
    }
    return NextResponse.json(report);
  } catch (error) {
    console.error("Install failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
