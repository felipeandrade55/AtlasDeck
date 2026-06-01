/**
 * GET /api/integrations/whatsapp/describe-plugin
 *
 * Spawns `openclaw plugin describe whatsapp` server-side and returns the
 * plugin's raw description (config schema, accepted keys, uiHints, etc).
 *
 * Why this exists: AtlasDeck speculates about plugin behavior in code
 * comments (e.g. `groupPolicy: "allowlist"` semantics, whether Baileys
 * read-state can be disabled). The only source of truth is the plugin
 * itself. This endpoint lets the UI surface that truth so future feature
 * work doesn't drift from reality.
 *
 * Best-effort: if the openclaw binary is missing or fails, we return the
 * error in a structured response instead of 500ing — the UI shows a hint
 * card and falls back to the speculative defaults.
 */
import { NextResponse } from "next/server";
import { spawnSync } from "child_process";
import { readOpenClawConfig } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

interface DescribeResult {
  ok: boolean;
  raw: string | null;
  /** Parsed JSON when the CLI emits machine-readable output. */
  parsed: unknown | null;
  /** Best-effort extraction of the accepted config keys, for the UI. */
  acceptedKeys: string[] | null;
  /** Best-effort extraction of any field describing read-state / presence /
   *  mention-handling, since those are the two questions we currently
   *  can't answer from code alone. */
  readStateClues: string[];
  mentionClues: string[];
  cli: { bin: string; cwd: string; durationMs: number };
  error?: string;
}

function scrape(text: string, needles: string[]): string[] {
  const lines = text.split("\n");
  const hits: string[] = [];
  const re = new RegExp(`(${needles.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "i");
  for (const line of lines) {
    if (re.test(line)) hits.push(line.trim());
    if (hits.length >= 20) break;
  }
  return hits;
}

export async function GET() {
  let bin = "openclaw";
  let cwd = process.cwd();
  try {
    const cfg = readOpenClawConfig();
    bin = cfg.openclawBin || bin;
    cwd = cfg.openclawDir || cwd;
  } catch {
    // fall through with defaults
  }

  const started = Date.now();
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(bin, ["plugin", "describe", "whatsapp"], {
      cwd,
      env: process.env,
      encoding: "utf-8",
      timeout: 10_000,
    });
  } catch (err) {
    const out: DescribeResult = {
      ok: false,
      raw: null,
      parsed: null,
      acceptedKeys: null,
      readStateClues: [],
      mentionClues: [],
      cli: { bin, cwd, durationMs: Date.now() - started },
      error: err instanceof Error ? err.message : String(err),
    };
    return NextResponse.json(out, { status: 200 });
  }

  const durationMs = Date.now() - started;
  const raw = `${result.stdout || ""}${result.stderr || ""}`.trim();

  if (result.error) {
    const out: DescribeResult = {
      ok: false,
      raw,
      parsed: null,
      acceptedKeys: null,
      readStateClues: [],
      mentionClues: [],
      cli: { bin, cwd, durationMs },
      error: result.error.message,
    };
    return NextResponse.json(out, { status: 200 });
  }

  // Try to parse as JSON — many openclaw subcommands support --json flags
  // or emit JSON natively. If the parse fails, we still return raw text.
  let parsed: unknown | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // not JSON; pretend it's documentation text
  }

  // Best-effort key extraction. Two heuristics:
  //  1. If parsed JSON has channelConfigs.whatsapp.schema.properties, use it.
  //  2. Otherwise, scrape lines that look like "  fieldName: <type>" or
  //     "- fieldName:" from the raw text.
  let acceptedKeys: string[] | null = null;
  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    const channel = (
      (p.channelConfigs as Record<string, unknown> | undefined)?.whatsapp ??
      (p.channels as Record<string, unknown> | undefined)?.whatsapp ??
      p.schema ??
      null
    ) as Record<string, unknown> | null;
    const props =
      (channel?.schema as Record<string, unknown> | undefined)?.properties ??
      (channel?.properties as Record<string, unknown> | undefined) ??
      null;
    if (props && typeof props === "object") {
      acceptedKeys = Object.keys(props);
    }
  }
  if (!acceptedKeys && raw) {
    const matches = raw.match(/^\s*[•\-*]?\s*([a-zA-Z][a-zA-Z0-9_]+)\s*[:?]/gm);
    if (matches && matches.length > 0) {
      acceptedKeys = Array.from(
        new Set(matches.map((m) => m.replace(/^\s*[•\-*]?\s*/, "").replace(/\s*[:?]\s*$/, "").trim())),
      ).slice(0, 100);
    }
  }

  const out: DescribeResult = {
    ok: result.status === 0,
    raw,
    parsed,
    acceptedKeys,
    readStateClues: scrape(raw, [
      "markOnlineOnConnect",
      "markRead",
      "autoRead",
      "presence",
      "subscribePresence",
      "keepAlive",
      "online",
      "syncHistory",
      "readReceipt",
      "readReceipts",
    ]),
    mentionClues: scrape(raw, [
      "mention",
      "mentionsOnly",
      "requireMention",
      "groupMention",
      "respondToMention",
    ]),
    cli: { bin, cwd, durationMs },
  };
  return NextResponse.json(out, { status: 200 });
}
