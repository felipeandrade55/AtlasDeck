/**
 * Manual control of the onboarding welcome notification.
 *
 *   GET  /api/memory/welcome   → { shown: boolean }
 *   POST /api/memory/welcome   → re-posts the welcome notification + clears the flag for next boot
 *   DELETE /api/memory/welcome → reset the flag so the scheduler posts again on next boot
 *
 * The scheduler posts this notification automatically on the first
 * boot of a fresh install (memories.db empty). This endpoint lets the
 * UI or the user trigger it on demand.
 */
import { NextResponse } from "next/server";
import { getSettings, setSettings, getStats } from "@/lib/memory-db";
import { getOllamaStatus } from "@/lib/ollama-client";
import { addNotification } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const settings = getSettings();
  return NextResponse.json({ shown: settings.welcome_notification_shown });
}

export async function POST() {
  const stats = getStats();
  const ollama = await getOllamaStatus().catch(() => null);
  const ollamaHint = !ollama || !ollama.installed
    ? "Dica: ative Ollama para zero custo (instruções no guia)."
    : ollama.running
    ? "Ollama detectado e rodando — pronto pra entrevista."
    : "Ollama instalado mas parado — confira o status no guia.";

  const message = [
    stats.total === 0
      ? "Abra o guia completo para conhecer o sistema menu por menu, fazer o setup da memória adaptativa e personalizar a identidade do seu agente."
      : `Você tem ${stats.total} memória(s) registrada(s). O guia revisa cada menu e te leva passo a passo pelo wizard de identidade.`,
    "",
    ollamaHint,
  ].join("\n");

  const notif = await addNotification(
    "👋 Comece por aqui — guia de boas-vindas",
    message,
    "info",
    "/welcome",
    { source: "memory-onboarding" },
  );

  setSettings({ welcome_notification_shown: true });

  return NextResponse.json({ success: true, notification: notif });
}

export async function DELETE() {
  setSettings({ welcome_notification_shown: false });
  return NextResponse.json({
    success: true,
    hint:
      "Flag resetada. A notificação de boas-vindas vai disparar no próximo boot do servidor se memories.db estiver vazio.",
  });
}
