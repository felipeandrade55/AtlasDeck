/**
 * The single source of truth for how agents should use memory.
 *
 * Before this, AGENTS.md said "write it to the file", MEMORY.md said
 * "call memory_add", the WhatsApp prompt referenced a non-existent
 * `memory_read` tool, and the guidance hardcoded the owner's name —
 * text that shipped to every SaaS customer. Everything now renders from
 * here, with the owner's name from settings.
 */
import { ownerDisplayName } from "@/lib/memory-service";

/** Heading the MCP diagnose looks for to confirm the guidance is present. */
export const GUIDANCE_MARKER = "Memória de longo prazo — como funciona";

/** Full guidance block (MEMORY.md auto-recall section). */
export function renderMemoryGuidance(owner = ownerDisplayName()): string {
  return `### ${GUIDANCE_MARKER}

O AtlasDeck guarda o que importa das suas conversas com ${owner} e aprende
com elas automaticamente depois de cada conversa. Quando houver memórias
relevantes para a mensagem atual, elas chegam junto da mensagem num bloco
\`<atlas-memory>\` — use-as como fatos já conhecidos, sem anunciar que
"consultou a memória".

Ferramentas do servidor MCP \`atlasdeck-memory\` (complementam o automático):
- **\`memory_search\`** — antes de responder "você lembra…?", "o que sabe
  sobre…?", ou quando o assunto pode ter sido falado em outra conversa e
  não veio no bloco \`<atlas-memory>\`.
- **\`memory_add\`** — quando ${owner} pedir para lembrar/anotar algo, ou
  disser "sempre"/"nunca"/"prefiro". Salve fatos autocontidos, com nomes
  próprios explícitos (cliente, projeto, marca).
- **\`memory_update\`** — quando ${owner} corrigir algo já salvo
  ("na verdade é…"): atualize, não duplique.
- **\`memory_get\`** — conteúdo completo de um resultado de busca.
- **\`conversation_search\`** / **\`conversation_get\`** — as conversas
  originais (web e Telegram). Use quando ${owner} citar algo falado antes
  que não está nas memórias ("o que combinamos sobre…", "aquele texto do
  cliente X").
- **\`memory_remove\`** — só quando pedirem explicitamente para esquecer.

Clientes, marcas e entregas (\`entity_get\`, \`entity_list\`, \`brand_kit_save\`,
\`deliverable_log\`, \`deliverable_search\`):
- Antes de produzir algo para um cliente, consulte \`entity_get\` (identidade
  visual e trabalhos anteriores) se isso não veio no bloco \`<atlas-memory>\`.
- Quando ${owner} passar ou corrigir a identidade visual de um cliente,
  registre com \`brand_kit_save\`. Ao concluir um trabalho para um cliente,
  registre com \`deliverable_log\` (o que foi feito, abordagem, identidade).

Regras:
- Nunca diga "salvei"/"anotei" sem ter chamado \`memory_add\` nesta resposta.
- Não salve conversa trivial, perguntas pontuais ou o que você mesmo
  sugeriu sem confirmação.
- Antes de reaproveitar algo de um cliente/projeto para outro (marca,
  cores, textos, estrutura), pergunte.
`;
}

/** Short version for AGENTS.md (the always-loaded bootstrap file). */
export function renderAgentsMemorySection(): string[] {
  return [
    "## Memória",
    "- A memória de longo prazo é gerenciada pelo AtlasDeck: ele aprende com as conversas e entrega o que for relevante junto da mensagem, num bloco `<atlas-memory>`.",
    "- Para buscar/salvar sob demanda use as tools MCP `memory_search`, `memory_add`, `memory_update`, `memory_get` (detalhes no MEMORY.md).",
    "- `memory/AAAA-MM-DD.md` é o diário cru do runtime; não é onde fatos duráveis devem morar.",
    "- Nunca diga que salvou algo sem ter chamado `memory_add`.",
  ];
}
