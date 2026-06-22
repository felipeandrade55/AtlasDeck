import { defaultSchema } from "rehype-sanitize";

/**
 * Schema de sanitização para o HTML que o Jarvis pode emitir nas respostas.
 *
 * Estende o schema padrão do GitHub (defaultSchema) para permitir layout e
 * estilo visual — `style`, `class`, tags estruturais — mantendo a allowlist
 * como única porta: qualquer atributo fora dela é removido. Isso significa que
 * `onclick`, `onerror`, `<script>`, `javascript:` etc. NUNCA passam, mesmo que
 * o modelo (ou um terceiro via prompt injection no Telegram/WhatsApp) tente.
 *
 * Trade-off conhecido: permitir `style` libera CSS arbitrário (cores, layout).
 * CSS não executa JS em navegadores modernos; o risco residual é cosmético
 * (ex.: position:fixed). Aceitável para respostas ricas numa ferramenta pessoal.
 */
export const chatSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "style", "className", "class"],
    a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
  },
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "div",
    "span",
    "section",
    "article",
    "details",
    "summary",
    "figure",
    "figcaption",
    "mark",
    "small",
    "sub",
    "sup",
  ],
};
