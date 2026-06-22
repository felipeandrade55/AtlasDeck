/**
 * Derives a short, human-friendly conversation title from the first user
 * message.
 *
 * The raw prompt is usually phrased as a command addressed to Jarvis
 * ("jarvis, monte pra mim uma tabela com o top 10 times da copa"). Showing
 * that verbatim in the sidebar is noisy — the user wants the *subject*
 * ("Top 10 times da copa"). We strip, in order:
 *   1. a leading greeting/vocative ("ei jarvis," / "oi" / "jarvis:")
 *   2. a leading imperative verb ("monte" / "crie" / "me diga" …)
 *   3. residual connective filler ("pra mim", "uma tabela com o", …)
 * then capitalize and cap the length. If stripping eats everything (e.g. the
 * message was *only* a command verb), we fall back to the collapsed prompt so
 * the title is never empty.
 *
 * Pure heuristic on purpose: no LLM call, so it stays instant and works
 * offline (AtlasDeck must run 1-click after a fresh clone).
 */
export function summarizeChatTitle(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return "Nova conversa";

  let s = collapsed;

  // 1. leading greeting / vocative addressed to the assistant
  s = s.replace(/^(ei|oi|olá|ola|hey|hello|opa|fala)\s+/i, "");
  s = s.replace(/^jarvis[\s,!:.\-–—]+/i, "").trim();

  // 2. leading imperative verb (optionally prefixed by "me")
  s = s
    .replace(
      /^(me\s+)?(monte|montar|crie|criar|cria|faça|faca|fazer|gere|gerar|elabore|elaborar|prepare|preparar|liste|listar|escreva|escrever|redija|redigir|mostre|mostrar|traga|tragas?|diga|me\s+diz|me\s+fala|fala|quero|preciso|preciso\s+de|gostaria\s+de|monta|cria)\b/i,
      "",
    )
    .trim();

  // 3. residual connective filler at the start (repeat until none match)
  const fillerRe =
    /^(pra\s+mim|para\s+mim|me\s+|uma?\s+|os?\s+|as?\s+|com\s+os?\s*|de\s+|do\s+|da\s+|dos\s+|das\s+|sobre\s+|tabela\s+(com|de|dos?|das?)\s+os?\s*|lista\s+(com|de|dos?|das?)\s+os?\s*|um\s+|uns\s+|umas\s+)/i;
  let guard = 0;
  while (fillerRe.test(s) && guard < 8) {
    s = s.replace(fillerRe, "").trim();
    guard += 1;
  }

  // If we over-stripped to nothing, recover the original.
  if (!s) s = collapsed;

  // Capitalize first letter without lowercasing the rest.
  s = s.charAt(0).toUpperCase() + s.slice(1);

  const MAX = 48;
  return s.length > MAX ? `${s.slice(0, MAX - 1).trimEnd()}…` : s;
}
