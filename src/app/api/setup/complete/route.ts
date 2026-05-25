import { NextResponse } from "next/server";
import { setSettings } from "@/lib/memory-db";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

export async function POST() {
  const now = new Date().toISOString();
  setSettings({ setup_step: "done", setup_completed_at: now });
  try {
    logActivity("config", "Setup inicial concluído pelo wizard /welcome", "success", {
      metadata: { completedAt: now },
    });
  } catch {}
  return NextResponse.json({ success: true, completedAt: now });
}
