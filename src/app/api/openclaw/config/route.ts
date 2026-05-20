import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getOpenClawConfigPath,
  readOpenClawConfig,
  writeOpenClawConfig,
  type OpenClawConfig,
} from "@/lib/openclaw-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

interface OpenClawStatus {
  dirExists: boolean;
  configExists: boolean;
  agentsDirExists: boolean;
  workspaceExists: boolean;
  binReachable: boolean;
  binDetail: string | null;
  sessionsReachable?: boolean;
  sessionsSeen?: number;
  sessionsDetail?: string | null;
}

function jsonNoStore(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { ...init, headers });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function sessionsCountFromPayload(payload: unknown): number {
  if (Array.isArray(payload)) return payload.length;
  if (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { sessions?: unknown[] }).sessions)
  ) {
    return ((payload as { sessions: unknown[] }).sessions).length;
  }
  return 0;
}

async function checkBin(config: OpenClawConfig): Promise<{ ok: boolean; detail: string | null }> {
  try {
    const { stdout, stderr } = await execFileAsync(config.openclawBin, ["--version"], {
      timeout: 3000,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });

    return {
      ok: true,
      detail: String(stdout || stderr || "").trim().split(/\r?\n/)[0] || "CLI encontrado",
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (err.code === "ENOENT") {
      return { ok: false, detail: `${config.openclawBin} nao encontrado no PATH` };
    }

    return {
      ok: true,
      detail: String(err.stdout || err.stderr || err.message || "CLI encontrado").trim().split(/\r?\n/)[0],
    };
  }
}

async function checkSessions(config: OpenClawConfig): Promise<Pick<OpenClawStatus, "sessionsReachable" | "sessionsSeen" | "sessionsDetail">> {
  const argSets = [
    ["sessions", "list", "--json"],
    ["sessions", "--json"],
    ["sessions", "list"],
    ["sessions"],
  ];

  for (const args of argSets) {
    try {
      const { stdout } = await execFileAsync(config.openclawBin, args, {
        timeout: 7000,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 5 * 1024 * 1024,
        env: {
          ...process.env,
          OPENCLAW_DIR: config.openclawDir,
          OPENCLAW_WORKSPACE: config.openclawWorkspace,
        },
      });
      const payload = JSON.parse(String(stdout));
      return {
        sessionsReachable: true,
        sessionsSeen: sessionsCountFromPayload(payload),
        sessionsDetail: `Formato: ${args.join(" ")}`,
      };
    } catch {
      // Try next format
    }
  }

  return {
    sessionsReachable: false,
    sessionsSeen: 0,
    sessionsDetail: "Nenhum formato de comando funcionou",
  };
}

async function buildStatus(config: OpenClawConfig, testSessions: boolean): Promise<OpenClawStatus> {
  const bin = await checkBin(config);
  const status: OpenClawStatus = {
    dirExists: fileExists(config.openclawDir),
    configExists: fileExists(path.join(config.openclawDir, "openclaw.json")),
    agentsDirExists: fileExists(path.join(config.openclawDir, "agents")),
    workspaceExists: fileExists(config.openclawWorkspace),
    binReachable: bin.ok,
    binDetail: bin.detail,
  };

  if (testSessions) {
    Object.assign(status, await checkSessions(config));
  }

  return status;
}

function defaultRoots(config: OpenClawConfig): string[] {
  const roots = new Set<string>();
  roots.add(config.openclawDir);
  roots.add(path.dirname(config.openclawDir));
  roots.add("/root");
  roots.add("/home");
  roots.add("/opt");
  roots.add("/srv");
  roots.add(process.cwd());

  if (process.platform === "win32") {
    roots.add(os.homedir());
    roots.add("C:\\");
    roots.add("D:\\");
  }

  return [...roots].filter(Boolean);
}

function candidate(pathname: string) {
  return {
    name: path.basename(pathname) || pathname,
    path: pathname,
    readable: fileExists(pathname),
    exists: fileExists(pathname),
    hasOpenClawConfig: fileExists(path.join(pathname, "openclaw.json")),
    hasAgentsDir: fileExists(path.join(pathname, "agents")),
  };
}

function commonCandidates(config: OpenClawConfig) {
  return [
    config.openclawDir,
    "/root/.openclaw",
    path.join(os.homedir(), ".openclaw"),
    "/opt/openclaw/.openclaw",
    "/srv/openclaw/.openclaw",
  ]
    .filter((item, index, list) => item && list.indexOf(item) === index)
    .map(candidate);
}

export async function GET(request: NextRequest) {
  const testSessions = request.nextUrl.searchParams.get("test") === "1";
  const config = readOpenClawConfig();
  const status = await buildStatus(config, testSessions);

  return jsonNoStore({
    config,
    status,
    roots: defaultRoots(config),
    candidates: commonCandidates(config),
    configPath: getOpenClawConfigPath(),
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as {
      openclawDir?: string;
      openclawBin?: string;
      openclawWorkspace?: string;
      test?: boolean;
    };

    const config = writeOpenClawConfig({
      openclawDir: body.openclawDir,
      openclawBin: body.openclawBin,
      openclawWorkspace: body.openclawWorkspace,
    });
    const status = await buildStatus(config, body.test === true);

    return jsonNoStore({
      success: true,
      config,
      status,
      roots: defaultRoots(config),
      candidates: commonCandidates(config),
      configPath: getOpenClawConfigPath(),
    });
  } catch (error) {
    return jsonNoStore(
      { error: "Falha ao salvar configuracao OpenClaw", detail: errorMessage(error) },
      { status: 400 }
    );
  }
}
