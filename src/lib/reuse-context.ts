/**
 * "Work context" for a turn: client brand kits and precedents.
 *
 * The behavior the owner asked for: after making a landing page for
 * client A with A's branding, when a later request is for client B the
 * assistant should ASK whether to reuse what was done before (structure,
 * approach) and which branding to use — never silently apply A's brand.
 *
 * Deterministic (no LLM in the hot path):
 *   1. find entities mentioned in the message (names/aliases);
 *   2. a mentioned client with a brand kit → inject the kit, with an
 *      instruction to use it and confirm in one line;
 *   3. a creation request (crie/faça/monte… + página/proposta/post…)
 *      for a client without a kit — or with no client named — and past
 *      deliverables of the same kind for OTHER clients → inject the most
 *      recent precedent with an instruction to ask before executing.
 * Each nudge fires at most once per conversation (recall_log), and the
 * reuse question is suppressed if the owner said they don't want it.
 */
import {
  describeBrandKit,
  findMentionedEntities,
  getBrandKit,
  listDeliverables,
  reusePromptSuppressed,
  type DeliverableRow,
  type EntityRow,
} from "@/lib/entity-db";
import { logRecall, wasRecalled } from "@/lib/memory-db";
import { sqliteTimeToMs } from "@/lib/chat-db";

const CREATE_RE =
  /\b(cri[ae]r?|cria|fa[cç]a|fazer|fazendo|mont[ae]r?|ger[ae]r?|desenvolv\w*|produz\w*|elabor\w*|prepar\w*|escrev\w*|redij\w*|refa[cç]a|refazer|construa|construir|desenh\w*|preciso de (um|uma|outr[oa])|quero (um|uma|outr[oa])|bora fazer|manda (um|uma))\b/i;

/** kind → families that count as "the same kind of work". */
const KIND_PATTERNS: Array<{ kind: string; family: string[]; re: RegExp }> = [
  { kind: "landing_page", family: ["landing_page", "site"], re: /\b(landing ?pages?|p[aá]ginas?|lps?)\b/i },
  { kind: "site", family: ["site", "landing_page"], re: /\b(sites?|websites?|portal)\b/i },
  { kind: "proposta", family: ["proposta"], re: /\b(propostas?|or[cç]amentos?)\b/i },
  { kind: "post", family: ["post"], re: /\b(posts?|carross[eé]is|carrossel|legendas?|reels?|stories|criativos?)\b/i },
  { kind: "apresentacao", family: ["apresentacao"], re: /\b(apresenta[cç](ão|ao|ões|oes)|slides?|decks?)\b/i },
  { kind: "logo", family: ["logo"], re: /\b(logos?|logotipos?|logomarcas?)\b/i },
  { kind: "email", family: ["email"], re: /\b(e-?mails?|newsletters?)\b/i },
  { kind: "documento", family: ["documento"], re: /\b(documentos?|relat[oó]rios?|contratos?)\b/i },
];

export interface CreationRequest {
  kind: string | null;
  family: string[] | null;
}

/**
 * Name of a client the message is about but we don't know yet
 * ("pro cliente Zeta Motors", "para a Padaria Sol"). Capitalized words
 * after pra/pro/para (o|a) [cliente|empresa]. Best-effort, display only.
 */
export function guessNewClientName(text: string): string | null {
  const m = text.match(
    /\b(?:pr[oa]|para(?:\s+[oa])?|da|do)\s+(?:(?:o|a)\s+)?(?:cliente|empresa|marca|loja)?\s*([A-ZÀ-Ý][\p{L}\p{N}&.'-]*(?:\s+(?:de|da|do|&)?\s*[A-ZÀ-Ý][\p{L}\p{N}&.'-]*){0,3})/u,
  );
  const name = m?.[1]?.trim();
  if (!name || name.length < 2) return null;
  if (/^(Eu|Ele|Ela|Isso|Esse|Essa|Hoje|Amanh[aã]|Black|Friday)$/i.test(name)) return null;
  return name;
}

export function detectCreationRequest(text: string): CreationRequest | null {
  if (!CREATE_RE.test(text)) return null;
  const match = KIND_PATTERNS.find((k) => k.re.test(text));
  return { kind: match?.kind ?? null, family: match?.family ?? null };
}

function clip(text: string | null | undefined, max: number): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function when(d: DeliverableRow): string {
  const ms = sqliteTimeToMs(d.created_at);
  return ms ? new Date(ms).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "antes";
}

const KIND_LABEL: Record<string, string> = {
  landing_page: "uma landing page",
  site: "um site",
  proposta: "uma proposta",
  post: "posts",
  apresentacao: "uma apresentação",
  logo: "um logo",
  email: "um e-mail",
  documento: "um documento",
};

export interface WorkContext {
  sections: string[];
  entityIds: string[];
  deliverableIds: string[];
}

export function buildWorkContext(message: string, workspace: string, sessionKey: string): WorkContext {
  const out: WorkContext = { sections: [], entityIds: [], deliverableIds: [] };
  const text = (message || "").trim();
  if (text.length < 4) return out;

  const mentioned = findMentionedEntities(workspace, text, ["client", "brand", "project", "organization"]);
  const clients = mentioned.filter((e) => e.type === "client" || e.type === "organization" || e.type === "brand");
  out.entityIds = mentioned.map((e) => e.id);

  // 1) Brand kits of the clients being talked about.
  const kitLines: string[] = [];
  for (const e of clients.slice(0, 2)) {
    const kit = getBrandKit(e);
    if (!kit || wasRecalled(sessionKey, "brand", e.id, 12)) continue;
    kitLines.push(`- **${e.name}**: ${describeBrandKit(kit)}`);
    logRecall(sessionKey, "brand", [e.id]);
  }
  if (kitLines.length) {
    out.sections.push(
      `Identidade visual registrada:\n${kitLines.join("\n")}\nSe for produzir material para esse cliente, use essa identidade e confirme em uma linha antes de executar ("vou usar a identidade da X: … — ok?").`,
    );
  }

  // 2) Precedent from another client for the same kind of work.
  const creation = detectCreationRequest(text);
  if (creation && !reusePromptSuppressed(workspace)) {
    const targetHasKit = clients.some((e) => Boolean(getBrandKit(e)));
    if (!targetHasKit) {
      const precedents = listDeliverables({
        workspace,
        kind: creation.family ?? undefined,
        excludeClientEntityIds: clients.map((e) => e.id),
        limit: 5,
      }).filter((d) => d.client_name && !wasRecalled(sessionKey, "precedent", d.id, 24));
      const top = precedents[0];
      if (top) {
        const target = clients[0] as EntityRow | undefined;
        const guessed = target ? null : guessNewClientName(text);
        const targetLabel = target ? `para ${target.name}` : guessed ? `para ${guessed}` : "para este trabalho";
        const details = [
          top.approach ? `abordagem: ${clip(top.approach, 160)}` : null,
          top.branding ? `identidade: ${clip(top.branding, 120)}` : null,
        ]
          .filter(Boolean)
          .join("; ");
        out.sections.push(
          `Precedente: em ${when(top)} você fez ${KIND_LABEL[top.kind] ?? top.kind} "${clip(top.title, 80)}" para ${top.client_name}${details ? ` (${details})` : ""}.\n` +
            `Antes de executar, PERGUNTE numa frase se quer reaproveitar a estrutura/abordagem desse trabalho e qual identidade visual usar ${targetLabel} — a própria${target ? ` da ${target.name}` : guessed ? ` da ${guessed}` : " do cliente"}, uma nova, ou a mesma da ${top.client_name}. Nunca aplique a marca da ${top.client_name} em outro cliente sem confirmação.`,
        );
        out.deliverableIds.push(top.id);
        logRecall(sessionKey, "precedent", [top.id]);
      }
    }
  }

  // 3) What was already done for the client being mentioned (continuity).
  for (const e of clients.slice(0, 1)) {
    if (wasRecalled(sessionKey, "client-history", e.id, 12)) continue;
    const past = listDeliverables({ workspace, clientEntityId: e.id, limit: 3 });
    if (!past.length) continue;
    out.sections.push(
      `Trabalhos anteriores para ${e.name}:\n${past
        .map((d) => `- ${when(d)}: ${KIND_LABEL[d.kind] ?? d.kind} "${clip(d.title, 70)}"${d.artifact_url || d.artifact_path ? ` (${d.artifact_url || d.artifact_path})` : ""}`)
        .join("\n")}`,
    );
    logRecall(sessionKey, "client-history", [e.id]);
  }

  return out;
}
