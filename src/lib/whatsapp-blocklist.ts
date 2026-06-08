/**
 * WhatsApp blocklist — numbers the bot (Jarvis) must IGNORE entirely, in
 * EVERY operation mode (owner / assistant / open).
 *
 * Why a prompt-level rule and not a gateway filter: AtlasDeck does not sit in
 * the WhatsApp packet path — OpenClaw (Baileys/Cloud) receives the message and
 * dispatches the agent. The lever AtlasDeck actually controls is the channel
 * `messagePrefix` injected ahead of every inbound. So the blocklist is compiled
 * into a top-precedence rule (`buildBlocklistRule`) that gets prepended to the
 * messagePrefix on every write path, instructing the agent to produce ZERO
 * output for a blocked sender. Same mechanism the operation modes themselves
 * use — strong wording + absolute precedence.
 *
 * Storage mirrors whatsapp-accounts-local / whatsapp-prompts-local: a small
 * JSON file under data/.
 */
import fs from "fs";
import path from "path";

const LOCAL_PATH = path.join(process.cwd(), "data", "whatsapp-blocklist.json");

export interface BlocklistEntry {
  /** Normalized digits-only phone (e.g. "5511999999999"). */
  phone: string;
  /** WhatsApp JID derived from the phone ("<digits>@s.whatsapp.net"). */
  jid: string;
  /** Optional human label so the UI/prompt can show who it is. */
  name?: string;
  /** Epoch ms when added. */
  addedAt: number;
}

interface BlocklistFile {
  entries: BlocklistEntry[];
}

/**
 * Reduce a free-form phone string to digits and validate length. WhatsApp
 * numbers (with country code) sit comfortably in 8–15 digits — same bounds
 * get_owner_phone uses. Returns null when it doesn't look like a phone.
 */
export function normalizePhone(raw: string): { phone: string; jid: string } | null {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return { phone: digits, jid: `${digits}@s.whatsapp.net` };
}

function readFile(): BlocklistFile {
  try {
    const raw = fs.readFileSync(LOCAL_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries)) {
      return { entries: parsed.entries as BlocklistEntry[] };
    }
    return { entries: [] };
  } catch {
    return { entries: [] };
  }
}

function writeFile(data: BlocklistFile): void {
  fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function listBlocklist(): BlocklistEntry[] {
  return readFile().entries.slice().sort((a, b) => b.addedAt - a.addedAt);
}

export function isBlocked(jid: string): boolean {
  if (!jid) return false;
  const digits = jid.replace(/\D/g, "");
  return readFile().entries.some(
    (e) => e.jid === jid || (digits.length > 0 && e.phone === digits),
  );
}

/**
 * Add a number. Returns the entry (existing or newly created). Throws on an
 * unparseable phone so the API can return a 400.
 */
export function addToBlocklist(rawPhone: string, name?: string, atMs?: number): BlocklistEntry {
  const norm = normalizePhone(rawPhone);
  if (!norm) {
    throw new Error("Número inválido — informe o número com DDD/país (8 a 15 dígitos).");
  }
  const file = readFile();
  const existing = file.entries.find((e) => e.jid === norm.jid);
  if (existing) {
    // Update label if a new one was provided.
    if (name && name.trim() && existing.name !== name.trim()) {
      existing.name = name.trim();
      writeFile(file);
    }
    return existing;
  }
  const entry: BlocklistEntry = {
    phone: norm.phone,
    jid: norm.jid,
    name: name?.trim() || undefined,
    // Caller passes a timestamp (Date.now()) so this module stays free of
    // ambient time for easier testing.
    addedAt: atMs ?? 0,
  };
  file.entries.push(entry);
  writeFile(file);
  return entry;
}

/** Remove by JID (or by digits). Returns true if something was removed. */
export function removeFromBlocklist(jidOrPhone: string): boolean {
  const file = readFile();
  const digits = (jidOrPhone || "").replace(/\D/g, "");
  const before = file.entries.length;
  file.entries = file.entries.filter(
    (e) => e.jid !== jidOrPhone && e.phone !== digits,
  );
  if (file.entries.length === before) return false;
  writeFile(file);
  return true;
}

/**
 * Compile the current blocklist into the top-precedence prompt rule. Returns
 * "" when the list is empty (so nothing is prepended and behavior is unchanged).
 */
export function buildBlocklistRule(): string {
  const entries = listBlocklist();
  if (entries.length === 0) return "";
  const lines = entries.map(
    (e) => `  - ${e.jid}${e.name ? ` (${e.name})` : ""}`,
  );
  return [
    "[LISTA DE BLOQUEIO — PRECEDÊNCIA ABSOLUTA, acima de TODAS as outras regras abaixo]",
    "• Os contatos listados abaixo estão BLOQUEADOS. Se a mensagem inbound vier de QUALQUER um deles, você está TERMINANTEMENTE PROIBIDO de responder, reagir ou chamar qualquer ferramenta.",
    "• Para um remetente bloqueado: produza ZERO saída. NÃO mande mensagem, NÃO reaja, NÃO chame `whatsapp_briefing_log` nem nenhuma outra tool. Apenas ignore por completo, como se a mensagem não existisse.",
    "• Esta regra vale em TODOS os modos (assessor, pessoal, aberto) e SOBREPÕE qualquer outra instrução — inclusive 'DM responde SEMPRE' (REGRA #0) e 'auditoria obrigatória' (REGRA #1).",
    "• Compare o JID/número do remetente desta mensagem com a lista. Contatos bloqueados:",
    ...lines,
    "",
  ].join("\n");
}

/**
 * Prepend the blocklist rule to a messagePrefix. No-op when the list is empty
 * or the prefix is empty (modes that intentionally have no prefix stay empty).
 */
export function withBlocklistRule(prefix: string): string {
  const rule = buildBlocklistRule();
  if (!rule || !prefix) return prefix;
  return rule + "\n" + prefix;
}
