import { NextRequest, NextResponse } from "next/server";
import { UpdateConfig, readUpdateConfig, writeUpdateConfig } from "@/lib/update";

export async function GET() {
  try {
    const config = readUpdateConfig();
    return NextResponse.json(config);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

const WRITABLE_KEYS: (keyof UpdateConfig)[] = [
  "autoCheck",
  "autoUpdate",
  "backupBeforeUpdate",
  "checkIntervalMinutes",
];

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<UpdateConfig>;
    // Mudou autoUpdate manualmente? Limpa o anti-loop pra próxima detecção
    // rodar normalmente — o usuário explicitou intenção, não devemos "lembrar"
    // de tentativas anteriores.
    const previous = readUpdateConfig();
    const patch: Partial<UpdateConfig> = {};
    for (const key of WRITABLE_KEYS) {
      if (key in body) (patch as Record<string, unknown>)[key] = body[key];
    }
    if ("autoUpdate" in patch && patch.autoUpdate !== previous.autoUpdate) {
      patch.lastAutoUpdateAttemptSha = null;
    }
    const config = writeUpdateConfig(patch);
    return NextResponse.json(config);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
