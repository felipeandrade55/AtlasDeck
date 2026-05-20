import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";
import { insertCronRun } from "@/lib/cron-runs-db";
import { addNotification } from "@/lib/notifications";

async function createNotification(title: string, message: string, type: "info" | "success" | "warning" | "error" = "info") {
  try {
    await addNotification(title, message, type);
  } catch (error) {
    console.error("Failed to create notification:", error);
  }
}

// POST: Trigger a cron job immediately
export async function POST(request: NextRequest) {
  let id: string | undefined;
  const startedAt = new Date().toISOString();
  try {
    const body = await request.json();
    id = body.id;

    if (!id) {
      return NextResponse.json({ error: "Job ID required" }, { status: 400 });
    }

    // Validate id is safe (alphanumeric, hyphens, underscores only)
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return NextResponse.json({ error: "Invalid job ID" }, { status: 400 });
    }

    const output = execSync(`openclaw cron run ${id} --force 2>&1`, {
      timeout: 15000,
      encoding: "utf-8",
    });

    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    // Persist success to local SQLite
    insertCronRun({
      job_id: id,
      started_at: startedAt,
      completed_at: completedAt,
      status: "success",
      duration_ms: durationMs,
      error: null,
      trigger_type: "manual",
    });

    // Create success notification
    await createNotification(
      "Cron Job Triggered",
      `Job "${id}" has been manually executed.`,
      "success"
    );

    return NextResponse.json({
      success: true,
      jobId: id,
      message: output.trim() || "Job triggered successfully",
    });
  } catch (error) {
    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    const message = error instanceof Error ? error.message : "Failed to trigger job";
    console.error("Error triggering cron job:", error);

    // Persist error to local SQLite
    insertCronRun({
      job_id: id || "unknown",
      started_at: startedAt,
      completed_at: completedAt,
      status: "error",
      duration_ms: durationMs,
      error: message,
      trigger_type: "manual",
    });
    
    // Create error notification using the id from the original body
    await createNotification(
      "Cron Job Failed",
      `Failed to execute job "${id || "unknown"}": ${message}`,
      "error"
    );
    
    // Even if the command exits with non-zero, the job might have been triggered
    // The openclaw CLI sometimes exits with error but still works
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
