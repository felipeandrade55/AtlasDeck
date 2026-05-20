import { NextResponse } from "next/server";
import { getActiveUpdate, liveLogPath } from "@/lib/update";
import fs from "fs";

export const dynamic = "force-dynamic";

/**
 * Snapshot do status atual do update + últimas N linhas do log.
 * Usado como fallback de polling quando SSE não está disponível,
 * e também ao montar o UpdatePanel para detectar update em andamento.
 *
 * Não dispara reconciliação aqui — a reconciliação roda no /stream endpoint.
 * Aqui apenas checamos heartbeat (via getActiveUpdate) para detectar processo morto.
 */
export async function GET() {
  const active = getActiveUpdate();
  if (!active) {
    return NextResponse.json({ active: false });
  }

  let logTail = "";
  try {
    const raw = fs.readFileSync(liveLogPath(), "utf-8");
    logTail = raw.slice(-20_000);
  } catch {}

  return NextResponse.json({
    active: true,
    status: active,
    logTail,
  });
}
