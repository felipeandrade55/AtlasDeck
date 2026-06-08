/**
 * GET/POST/DELETE /api/integrations/whatsapp/blocklist
 *
 * Manage the list of numbers Jarvis must IGNORE in every operation mode.
 *
 * The list is stored in data/whatsapp-blocklist.json (see lib/whatsapp-blocklist).
 * On every mutation we re-write ONLY `channels.whatsapp.messagePrefix` for the
 * currently-active mode — recomputed via operationModeToChannelConfig, which
 * now prepends the blocklist rule — so the gateway hot-reload (~1-2s) picks up
 * the change without touching any other channel knob (Baileys, dmPolicy, etc).
 *
 *   GET    → { entries }
 *   POST   → { phone, name? }  adds a number, returns updated { entries }
 *   DELETE → ?jid=… (or body { jid }) removes, returns updated { entries }
 */
import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import {
  getWhatsappAccountLocal,
  operationModeToChannelConfig,
  type WhatsappOperationMode,
} from "@/lib/whatsapp-accounts-local";
import {
  listBlocklist,
  addToBlocklist,
  removeFromBlocklist,
} from "@/lib/whatsapp-blocklist";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

/**
 * Best-effort detection of the live operation mode: prefer the per-account
 * value AtlasDeck records on every mode switch; fall back to inferring from
 * the openclaw.json channel config (same heuristic as the prompts route).
 */
function resolveActiveMode(accountId: string): WhatsappOperationMode {
  const local = getWhatsappAccountLocal(accountId).operationMode;
  if (local) return local;
  try {
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    if (!existsSync(configPath)) return "passive";
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const wa = raw?.channels?.whatsapp ?? {};
    const dm = wa.dmPolicy;
    if (dm === "open") {
      const prefix = typeof wa.messagePrefix === "string" ? wa.messagePrefix : "";
      if (prefix.includes("[MODO ASSESSOR")) return "assistant";
      if (prefix.includes("[MODO PESSOAL")) return "owner";
      return "open";
    }
    if (dm === "pairing") return "pairing";
    return "passive";
  } catch {
    return "passive";
  }
}

/**
 * Re-write only messagePrefix for the active mode so the new blocklist takes
 * effect via hot-reload. Returns true when the live config was touched.
 */
function reapplyBlocklistToLiveConfig(accountId: string): boolean {
  const mode = resolveActiveMode(accountId);
  const applied = operationModeToChannelConfig(mode);
  try {
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    if (!existsSync(configPath)) return false;
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!raw.channels || typeof raw.channels !== "object") raw.channels = {};
    const wa =
      raw.channels.whatsapp && typeof raw.channels.whatsapp === "object"
        ? (raw.channels.whatsapp as Record<string, unknown>)
        : {};
    if (applied.messagePrefix) wa.messagePrefix = applied.messagePrefix;
    else delete wa.messagePrefix;
    raw.channels.whatsapp = wa;
    writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  return NextResponse.json({ entries: listBlocklist() });
}

export async function POST(req: NextRequest) {
  let body: { phone?: string; name?: string; accountId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }

  const accountId = (body.accountId || "main").trim();
  try {
    const entry = addToBlocklist(body.phone || "", body.name, Date.now());
    const appliedLive = reapplyBlocklistToLiveConfig(accountId);
    try {
      logActivity(
        "config",
        `Número adicionado à lista de bloqueio do WhatsApp: ${entry.jid}${entry.name ? ` (${entry.name})` : ""}`,
        "success",
        { metadata: { jid: entry.jid, appliedLive } },
      );
    } catch {}
    return NextResponse.json({
      ok: true,
      entry,
      entries: listBlocklist(),
      appliedLive,
      hint: appliedLive
        ? "Bloqueio salvo e aplicado — hot-reload do gateway pega em ~1-2s."
        : "Bloqueio salvo. Ele entra em vigor da próxima vez que o modo for aplicado.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  let jid = searchParams.get("jid") || "";
  if (!jid) {
    try {
      const body = (await req.json()) as { jid?: string };
      jid = (body.jid || "").trim();
    } catch {
      // no body — fall through to validation below
    }
  }
  if (!jid) {
    return NextResponse.json({ error: "Informe o jid a remover." }, { status: 400 });
  }

  const accountId = searchParams.get("accountId") || "main";
  const removed = removeFromBlocklist(jid);
  const appliedLive = removed ? reapplyBlocklistToLiveConfig(accountId) : false;
  if (removed) {
    try {
      logActivity(
        "config",
        `Número removido da lista de bloqueio do WhatsApp: ${jid}`,
        "success",
        { metadata: { jid, appliedLive } },
      );
    } catch {}
  }
  return NextResponse.json({ ok: true, removed, entries: listBlocklist(), appliedLive });
}
