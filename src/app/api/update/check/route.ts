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
    // The check fails when there's no local `.git` (tarball/container
    // deploys) or the GitHub API is unreachable / rate-limited. None of
    // that is a server fault — returning 500 just spams the console and
    // flips the UI into an error state. Degrade to a soft "unknown, no
    // update" payload (HTTP 200) so the banner simply stays hidden.
    const message = error instanceof Error ? error.message : "Unknown error";
    if (process.env.MEMORY_DEBUG === "1") {
      console.warn("[update/check] degraded to soft response:", message);
    }
    return NextResponse.json({
      hasUpdate: false,
      unavailable: true,
      error: message,
      localSha: "unknown",
      remoteSha: "",
      behindBy: 0,
      commits: [],
      checkedAt: new Date().toISOString(),
    });
  }
}
