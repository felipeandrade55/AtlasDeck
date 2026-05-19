import { NextRequest, NextResponse } from "next/server";
import {
  readBackupConfig,
  writeBackupConfig,
  scheduleSystemCron,
  getSystemCronStatus,
} from "@/lib/backup";

// GET: Current schedule status
export async function GET() {
  try {
    const config = readBackupConfig();
    const cronStatus = getSystemCronStatus();
    return NextResponse.json({
      config,
      cronStatus,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST: Update schedule
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      enabled,
      schedule,
      retentionDays,
      destination,
    }: {
      enabled?: boolean;
      schedule?: string;
      retentionDays?: number;
      destination?: string;
    } = body;

    const current = readBackupConfig();

    // Update config
    const nextConfig = {
      ...current,
      enabled: enabled ?? current.enabled,
      schedule: schedule ?? current.schedule,
      retentionDays:
        retentionDays !== undefined ? retentionDays : current.retentionDays,
      destination: destination ?? current.destination,
    };
    writeBackupConfig(nextConfig);

    // Parse schedule HH:MM into hours and minutes
    let hours = 4;
    let minutes = 0;
    if (nextConfig.schedule) {
      const parts = nextConfig.schedule.split(":");
      if (parts.length === 2) {
        hours = parseInt(parts[0], 10);
        minutes = parseInt(parts[1], 10);
      }
    }

    // Update system crontab
    const projectDir = process.cwd();
    const cronResult = scheduleSystemCron(
      projectDir,
      minutes,
      hours,
      nextConfig.enabled
    );

    return NextResponse.json({
      success: cronResult.success,
      config: nextConfig,
      cronMessage: cronResult.message,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[api/backup/schedule] POST error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
