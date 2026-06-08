/**
 * GET/PUT /api/integrations/whatsapp/prompts
 *
 * View and edit the per-mode `messagePrefix` injected into every inbound
 * WhatsApp message before the agent sees it. The defaults live in
 * `buildDefaultChannelConfig()` (whatsapp-accounts-local.ts); overrides
 * are persisted in `data/whatsapp-prompts.json`.
 *
 * GET → returns every mode with { default, current, isCustom } so the modal
 *       can render side-by-side. Also returns `activeMode` (the operationMode
 *       currently applied to openclaw.json) so the UI can mark which prompt
 *       is "live right now".
 *
 * PUT  → { mode, prompt } saves an override. If `prompt` is empty or
 *        matches the default exactly, the override is cleared. If the
 *        edited mode IS the active mode, the new prompt is also written
 *        into `channels.whatsapp.messagePrefix` so hot-reload picks it
 *        up in ~1-2s without touching the rest of the channel config.
 */
import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
import {
  getDefaultMessagePrefix,
  type WhatsappOperationMode,
} from "@/lib/whatsapp-accounts-local";
import {
  getAllMessagePrefixOverrides,
  setMessagePrefixOverride,
  clearMessagePrefixOverride,
} from "@/lib/whatsapp-prompts-local";
import { withBlocklistRule } from "@/lib/whatsapp-blocklist";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

const ALL_MODES: WhatsappOperationMode[] = [
  "passive",
  "owner",
  "assistant",
  "open",
  "pairing",
];

// Modes whose default messagePrefix is intentionally empty. Editing these
// has no runtime effect because dmPolicy is disabled/pairing and the gateway
// never asks the agent for a reply — surface that fact in the UI so the
// user doesn't think the editor is broken.
const NO_PROMPT_MODES: WhatsappOperationMode[] = ["passive", "pairing"];

/** Read the active mode the same way the main route's GET infers it: prefer
 *  the local per-account operationMode (first account), else fall back to
 *  the channel-level dmPolicy. Keeps "what's live" consistent across views. */
function readActiveMode(): WhatsappOperationMode {
  try {
    const { path: configPath } = resolveOpenClawAgentsConfigPath();
    if (!existsSync(configPath)) return "passive";
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const dm = raw?.channels?.whatsapp?.dmPolicy;
    if (dm === "open") {
      // open + assistant/owner all share dmPolicy="open" — disambiguate via
      // the actual messagePrefix to pick the right label.
      const prefix = raw?.channels?.whatsapp?.messagePrefix || "";
      if (typeof prefix === "string") {
        if (prefix.includes("[MODO ASSESSOR")) return "assistant";
        if (prefix.includes("[MODO PESSOAL")) return "owner";
      }
      return "open";
    }
    if (dm === "pairing") return "pairing";
    return "passive";
  } catch {
    return "passive";
  }
}

export async function GET() {
  const overrides = getAllMessagePrefixOverrides();
  const modes = ALL_MODES.map((mode) => {
    const def = getDefaultMessagePrefix(mode);
    const override = overrides[mode];
    const isCustom = typeof override === "string" && override !== def;
    return {
      mode,
      default: def,
      current: isCustom ? override : def,
      isCustom,
      editable: !NO_PROMPT_MODES.includes(mode),
    };
  });

  return NextResponse.json({
    activeMode: readActiveMode(),
    modes,
  });
}

export async function PUT(req: NextRequest) {
  let body: { mode?: string; prompt?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }

  const mode = (body.mode || "").trim() as WhatsappOperationMode;
  if (!ALL_MODES.includes(mode)) {
    return NextResponse.json(
      { error: `mode inválido. Use um destes: ${ALL_MODES.join(", ")}` },
      { status: 400 },
    );
  }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const def = getDefaultMessagePrefix(mode);

  // Clearing rule: empty string or text identical to the default → no
  // override stored (keeps the JSON file minimal and means the user can
  // freely re-edit later without leftover state).
  const shouldClear = prompt === "" || prompt === def;

  try {
    if (shouldClear) {
      clearMessagePrefixOverride(mode);
    } else {
      setMessagePrefixOverride(mode, prompt);
    }

    // Hot-reload only when the edited mode IS the currently-active mode.
    // Otherwise editing "owner" while in "assistant" would silently inject
    // owner's text into the live config — exactly the "I just changed
    // something and the bot started talking weird" footgun we want to
    // avoid. The new text takes effect the next time the user picks this
    // mode in the dropdown.
    const activeMode = readActiveMode();
    let appliedLive = false;
    if (activeMode === mode) {
      const { path: configPath } = resolveOpenClawAgentsConfigPath();
      if (existsSync(configPath)) {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!raw.channels || typeof raw.channels !== "object") raw.channels = {};
        const wa =
          raw.channels.whatsapp && typeof raw.channels.whatsapp === "object"
            ? (raw.channels.whatsapp as Record<string, unknown>)
            : {};
        // Prepend the blocklist rule so a custom/cleared prompt never drops
        // the "ignore these numbers" guard (operationModeToChannelConfig does
        // the same on the mode/PUT paths).
        const effective = withBlocklistRule(shouldClear ? def : prompt);
        if (effective) wa.messagePrefix = effective;
        else delete wa.messagePrefix;
        raw.channels.whatsapp = wa;
        writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
        appliedLive = true;
      }
    }

    try {
      logActivity(
        "config",
        `Prompt do modo "${mode}" ${shouldClear ? "revertido para o padrão" : "personalizado"}${appliedLive ? " (aplicado ao gateway via hot-reload)" : ""}`,
        "success",
        { metadata: { mode, isCustom: !shouldClear, appliedLive } },
      );
    } catch {}

    return NextResponse.json({
      ok: true,
      mode,
      isCustom: !shouldClear,
      appliedLive,
      activeMode,
      hint: appliedLive
        ? "Prompt salvo e aplicado — hot-reload do gateway pega em ~1-2s."
        : "Prompt salvo. Como este modo não é o ativo, o texto só entra em vigor da próxima vez que você selecionar este modo no dropdown.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
