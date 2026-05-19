import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";
import { getRunsByJobId, type CronRunRecord } from "@/lib/cron-runs-db";

interface RunEntry {
  id: string;
  jobId: string;
  startedAt: string | null;
  completedAt: string | null;
  status: string;
  durationMs: number | null;
  error: string | null;
  triggerType?: string;
}

function dbRecordToEntry(r: CronRunRecord): RunEntry {
  return {
    id: r.id,
    jobId: r.job_id,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    status: r.status,
    durationMs: r.duration_ms,
    error: r.error,
    triggerType: r.trigger_type,
  };
}

// GET: Fetch run history for a cron job
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Job ID required" }, { status: 400 });
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return NextResponse.json({ error: "Invalid job ID" }, { status: 400 });
    }

    // 1. Read from local SQLite (primary source)
    const dbRuns = getRunsByJobId(id, 50);
    const runs: RunEntry[] = dbRuns.map(dbRecordToEntry);

    // 2. Fallback: try OpenClaw CLI if SQLite is empty
    if (runs.length === 0) {
      try {
        const output = execSync(`openclaw cron runs ${id} --json 2>/dev/null`, {
          timeout: 10000,
          encoding: "utf-8",
        });

        const data = JSON.parse(output);
        const rawRuns: Array<{
          id?: string;
          startedAt?: string;
          createdAt?: string;
          completedAt?: string;
          finishedAt?: string;
          status?: string;
          durationMs?: number;
          error?: string;
        }> = data.runs || data || [];

        const cliRuns = rawRuns.map((r) => ({
          id: r.id || `${id}-${r.startedAt}`,
          jobId: id,
          startedAt: r.startedAt || r.createdAt || null,
          completedAt: r.completedAt || r.finishedAt || null,
          status: r.status || "unknown",
          durationMs:
            r.durationMs ||
            (r.startedAt && r.completedAt
              ? new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()
              : null),
          error: r.error || null,
        }));

        runs.push(...cliRuns);
      } catch {
        // CLI might not support runs — ignore
      }
    }

    return NextResponse.json({ runs, total: runs.length });
  } catch (error) {
    console.error("Error fetching run history:", error);
    return NextResponse.json({ error: "Failed to fetch run history" }, { status: 500 });
  }
}
