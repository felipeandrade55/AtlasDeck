import { NextRequest, NextResponse } from "next/server";
import { getGlobalStats, getJobStats } from "@/lib/cron-runs-db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("jobId");

    if (jobId) {
      const stats = getJobStats(jobId, 30);
      return NextResponse.json({ jobId, stats });
    }

    const global7d = getGlobalStats(7);
    const global24h = getGlobalStats(1);

    return NextResponse.json({
      global: {
        last7d: global7d,
        last24h: global24h,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[api/cron/stats] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
