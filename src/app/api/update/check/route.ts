import { NextResponse } from "next/server";
import { checkForUpdates } from "@/lib/update";
import { notifyIfNewUpdate } from "@/lib/update-notifier";
import { startUpdateScheduler } from "@/lib/update-scheduler";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    // Garante que o agendador em background está rodando
    startUpdateScheduler();

    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";

    const result = await checkForUpdates(force);

    // Dispara notificação no sino se houver SHA novo não-notificado
    await notifyIfNewUpdate(result);

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
