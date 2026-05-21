/**
 * Install/uninstall/status for the morning briefing cron job on the OpenClaw gateway.
 *
 * GET    — returns whether the job exists
 * POST   — creates the job (idempotent)
 * DELETE — removes the job
 */
import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";
import { getServiceToken } from "@/lib/openclaw-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JOB_NAME = "atlasdeck-morning-briefing";
const SCHEDULE = "0 7 * * *"; // 07:00 every day
const TZ = "America/Sao_Paulo";

function listJobs(): Array<{ id: string; name?: string }> | null {
  try {
    const out = execSync("openclaw cron list --json --all 2>/dev/null", { timeout: 10000, encoding: "utf-8" });
    const data = JSON.parse(out) as { jobs?: Array<{ id: string; name?: string }> };
    return data.jobs ?? [];
  } catch {
    return null;
  }
}

function findJob(): { id: string; name?: string } | null {
  const jobs = listJobs();
  if (!jobs) return null;
  return jobs.find((j) => j.name === JOB_NAME) ?? null;
}

function getBaseUrl(request: NextRequest): string {
  return process.env.ATLASDECK_BASE_URL || new URL(request.url).origin;
}

export async function GET() {
  const jobs = listJobs();
  if (jobs === null) {
    return NextResponse.json({ installed: false, available: false, error: "openclaw CLI indisponível neste host" });
  }
  const found = jobs.find((j) => j.name === JOB_NAME);
  return NextResponse.json({
    installed: !!found,
    available: true,
    job: found ?? null,
    schedule: SCHEDULE,
    timezone: TZ,
  });
}

export async function POST(request: NextRequest) {
  const token = getServiceToken();
  if (!token) {
    return NextResponse.json(
      { error: "OPENCLAW_SERVICE_TOKEN não configurado. Rode a instalação do calendário primeiro ou defina a variável de ambiente." },
      { status: 400 }
    );
  }

  const existing = findJob();
  if (existing) {
    return NextResponse.json({ installed: true, already_existed: true, job: existing });
  }

  const url = `${getBaseUrl(request).replace(/\/$/, "")}/api/agent/morning-briefing`;
  const shell = `curl -fsS -X POST -H "x-openclaw-token: ${token}" "${url}" > /dev/null`;

  const cmd = [
    "openclaw",
    "cron",
    "create",
    "--name",
    JSON.stringify(JOB_NAME),
    "--schedule",
    JSON.stringify(SCHEDULE),
    "--tz",
    JSON.stringify(TZ),
    "--shell",
    JSON.stringify(shell),
  ].join(" ");

  try {
    execSync(cmd, { timeout: 15000, encoding: "utf-8" });
    return NextResponse.json({ installed: true, schedule: SCHEDULE, timezone: TZ });
  } catch (err) {
    return NextResponse.json(
      { error: "Falha ao criar cron via openclaw CLI", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  const existing = findJob();
  if (!existing) {
    return NextResponse.json({ removed: false, reason: "not_installed" });
  }
  try {
    execSync(`openclaw cron remove ${JSON.stringify(existing.id)} 2>/dev/null`, { timeout: 10000, encoding: "utf-8" });
    return NextResponse.json({ removed: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Falha ao remover cron", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
