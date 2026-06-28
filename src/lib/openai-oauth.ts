/**
 * OpenAI OAuth (device-code) lifecycle for the setup wizard.
 *
 * Drives `openclaw models auth login --provider openai --device-code --set-default`,
 * which prints a verification URL + user code and then blocks until the user
 * authorizes in their browser. We spawn it once, scrape the URL/code from its
 * output so the web wizard can show them, and keep the child alive until it
 * exits — success (code 0) means the OAuth profile was saved by OpenClaw.
 *
 * Single-user app ⇒ a module-level singleton session is enough. The flow is
 * headless-friendly: the user never touches a terminal, only clicks a link and
 * pastes the code OpenClaw shows.
 */
import { spawn, type ChildProcess } from "child_process";
import { readOpenClawConfig } from "./openclaw-config";
import { setSettings } from "./memory-db";

export type OAuthStatus = "starting" | "awaiting" | "success" | "error";

export interface OAuthSnapshot {
  status: OAuthStatus;
  provider: string;
  verificationUrl: string | null;
  userCode: string | null;
  error: string | null;
  output: string;
  startedAt: number;
}

interface OAuthSession extends OAuthSnapshot {
  child: ChildProcess;
}

let session: OAuthSession | null = null;

// Tolerant scrapers: any https URL, and the common XXXX-XXXX device-code shape.
const URL_RE = /(https?:\/\/[^\s"'<>]+)/i;
const CODE_RE = /\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/;

function snapshot(s: OAuthSession): OAuthSnapshot {
  const { child: _child, ...rest } = s;
  void _child;
  return { ...rest };
}

export function getOAuthSnapshot(): OAuthSnapshot | null {
  return session ? snapshot(session) : null;
}

/**
 * Start (or reuse an in-flight) device-code login. Returns immediately with a
 * snapshot; the URL/code may only appear a beat later — the caller should poll.
 */
export function startOpenAiDeviceLogin(opts: { provider?: string } = {}): OAuthSnapshot {
  if (session && (session.status === "starting" || session.status === "awaiting")) {
    return snapshot(session);
  }

  const provider = opts.provider || "openai";
  const bin = readOpenClawConfig().openclawBin || "openclaw";
  const child = spawn(
    bin,
    ["models", "auth", "login", "--provider", provider, "--device-code", "--set-default"],
    { env: process.env, windowsHide: true },
  );

  const s: OAuthSession = {
    child,
    status: "starting",
    provider,
    verificationUrl: null,
    userCode: null,
    error: null,
    output: "",
    startedAt: Date.now(),
  };
  session = s;

  const ingest = (chunk: Buffer | string) => {
    const text = chunk.toString();
    s.output = (s.output + text).slice(-8000);
    if (!s.verificationUrl) {
      const m = s.output.match(URL_RE);
      if (m) s.verificationUrl = m[1];
    }
    if (!s.userCode) {
      const m = s.output.match(CODE_RE);
      if (m) s.userCode = m[1];
    }
    if (s.status === "starting" && (s.verificationUrl || s.userCode)) {
      s.status = "awaiting";
    }
  };

  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");
  child.stdout?.on("data", ingest);
  child.stderr?.on("data", ingest);

  child.on("error", (err) => {
    s.status = "error";
    s.error = `Falha ao iniciar o login: ${err.message}`;
  });

  child.on("close", (code) => {
    if (s.status === "error") return;
    if (code === 0) {
      s.status = "success";
      try {
        setSettings({ ai_oauth_provider: provider });
      } catch {
        // best-effort; status route also tolerates absence
      }
    } else {
      s.status = "error";
      s.error = s.error || `O login terminou com código ${code}. Tente novamente.`;
    }
  });

  return snapshot(s);
}

/** Cancel an in-flight login (e.g. user backed out). */
export function cancelOAuthSession(): void {
  if (session && (session.status === "starting" || session.status === "awaiting")) {
    try {
      session.child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  session = null;
}
