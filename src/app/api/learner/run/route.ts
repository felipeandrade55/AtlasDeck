import { NextResponse } from "next/server";
import { runLearnerOnce, getLearnerState } from "@/lib/learner-scheduler";

export const dynamic = "force-dynamic";

/**
 * Manual trigger for the Learner Agent. Same pass as the hourly cron — UI
 * calls this when the user clicks "ingerir feedback agora" after batch
 * approving several tasks.
 */
export async function POST() {
  try {
    const result = runLearnerOnce();
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  // Surface the watermark + totals so the UI can show "last run: X min ago"
  return NextResponse.json({ state: getLearnerState() });
}
