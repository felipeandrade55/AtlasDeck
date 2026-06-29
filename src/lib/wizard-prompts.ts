/**
 * Wizard prompts for the onboarding interview + file generation.
 *
 * Two prompts:
 *   - INTERVIEWER_PROMPT — decides the next question given what we have so far
 *   - GENERATOR_PROMPT   — builds IDENTITY.md / SOUL.md / USER.md from the conversation
 *
 * Kept in PT-BR by design — the user wants the conversation in Portuguese.
 */

export interface WizardTurn {
  question: string;
  answer: string;
}

export interface InterviewerOutput {
  /** When false, more questions remain; when true, the wizard is done. */
  complete: boolean;
  /** Next question to ask the user; required when complete=false. */
  next_question?: string;
  /** Internal tracking of topics covered so far. */
  covered?: string[];
  /** Short, friendly recap shown to the user when complete=true. */
  summary?: string;
}

export interface GeneratedFiles {
  "IDENTITY.md": string;
  "SOUL.md": string;
  "USER.md": string;
}

const TOPICS = [
  "nome e contexto pessoal do usuário (profissão, onde mora, idiomas)",
  "estilo de trabalho técnico (linguagens, frameworks, ferramentas, convenções)",
  "preferências de comunicação (formal/informal, idioma do agente, tamanho de resposta)",
  "personalidade e tom do agente (nome do agente, vibe, valores, limites)",
  "projeto principal ou foco atual (o que está construindo, prazos, parceiros)",
  "rotina (horário preferido pro briefing matinal, faixas de foco/reuniões — opcional)",
];

export function buildInterviewerPrompt(history: WizardTurn[]): string {
  const historyText = history
    .map((h, i) => `[${i + 1}] PERGUNTA: ${h.question}\n    RESPOSTA: ${h.answer}`)
    .join("\n\n");

  return `Você é um entrevistador empático que está coletando dados para configurar a memória de um agente IA personalizado. Toda a conversa acontece em português brasileiro.

# Tópicos que precisam ser cobertos
${TOPICS.map((t, i) => `${i + 1}. ${t}`).join("\n")}

# Regras
- Faça **uma** pergunta de cada vez, curta e direta
- Comece pelos tópicos mais importantes e pessoais
- Se a resposta anterior já cobriu vários tópicos, pule pra um ainda não coberto
- Use linguagem informal e calorosa, mas objetiva
- Quando os tópicos essenciais tiverem informação suficiente (ou após no máximo 8 perguntas), marque complete=true. O tópico de rotina é opcional — se sobrar espaço, pergunte; senão pule.
- Não invente respostas — só processe o que o usuário disse
- NÃO repita perguntas já feitas

# Histórico até agora
${history.length === 0 ? "(nenhuma pergunta feita ainda — esta será a primeira)" : historyText}

# Saída obrigatória (apenas JSON válido, sem markdown wrapper)
Se ainda falta tópico:
{"complete": false, "next_question": "...", "covered": ["tópico1", "tópico2"]}

Se já tem contexto suficiente:
{"complete": true, "summary": "Resumo amigável em 2-3 linhas do que você captou sobre o usuário"}`;
}

const SKIPPED_ANSWER = "(usuário preferiu pular)";

/**
 * Deterministic, LLM-free generator. Used as a graceful fallback when
 * no provider (Ollama / OpenClaw) is reachable, so the wizard always
 * completes — the user reviews + edits the scaffold in the next step.
 *
 * Answers are slotted into the right sections by matching keywords in
 * the question text; anything unmatched lands in "Contexto adicional".
 */
export function buildFallbackFiles(history: WizardTurn[]): GeneratedFiles {
  const usable = history.filter(
    (h) => h.answer.trim() && h.answer.trim() !== SKIPPED_ANSWER,
  );
  const pick = (re: RegExp): string[] =>
    usable.filter((h) => re.test(h.question.toLowerCase())).map((h) => h.answer.trim());

  const about = pick(/nome|faz no dia|profiss|trabalh|sobre voc/);
  const stack = pick(/stack|linguagem|framework|ferrament|tecnolog/);
  const comms = pick(/comunic|formal|informal|curtas|detalhad|\btom\b/);
  const persona = pick(/vibe|personalidad|agente|limite|cruzar/);
  const project = pick(/projeto|construindo|\bfoco\b|prazo/);

  const matched = new Set([...about, ...stack, ...comms, ...persona, ...project]);
  const extra = usable
    .filter((h) => !matched.has(h.answer.trim()))
    .map((h) => `- **${h.question.trim()}** ${h.answer.trim()}`);

  const today = new Date().toISOString().slice(0, 10);
  const para = (arr: string[], fallback = "(não informado)") =>
    arr.length ? arr.join("\n\n") : fallback;
  const bullets = (arr: string[], fallback = "(não informado)") =>
    arr.length ? arr.map((a) => `- ${a}`).join("\n") : `- ${fallback}`;
  const note = "> Rascunho gerado sem IA a partir das suas respostas — revise e edite antes de salvar.\n\n";

  const identity = `${note}# IDENTITY

- **Name:** (defina o nome do agente)
- **Emoji:** 🤖
- **Role:** Assistente pessoal
- **Created:** ${today}

## Mission
Apoiar ${about.length ? "o usuário descrito abaixo" : "o usuário"} no dia a dia, conforme o contexto coletado.

## Owner
${para(about)}
`;

  const soul = `${note}# SOUL

## Tom
${para(comms)}

## Valores
- (defina os valores do agente)

## Linguagem
Português brasileiro.

## Limites
${bullets(persona, "(defina os limites do agente)")}

## Vibe
${para(persona)}
`;

  const user = `${note}# USER

## Sobre mim
${para(about)}

## Stack técnica
${bullets(stack)}

## Preferências de trabalho
${para(comms)}

## Projeto atual
${para(project)}

## Contexto adicional
${extra.length ? extra.join("\n") : "(não informado)"}
`;

  return { "IDENTITY.md": identity, "SOUL.md": soul, "USER.md": user };
}

export function buildGeneratorPrompt(history: WizardTurn[]): string {
  const historyText = history
    .map((h, i) => `[${i + 1}] Q: ${h.question}\n    A: ${h.answer}`)
    .join("\n\n");

  return `Você vai gerar 3 arquivos markdown que configuram a memória de longo prazo de um agente IA. Toda saída em português brasileiro.

# Entrevista coletada
${historyText}

# Arquivos a gerar

## IDENTITY.md — quem o agente é
Estrutura sugerida:
\`\`\`
# IDENTITY

- **Name:** <nome escolhido pelo usuário pro agente>
- **Emoji:** <um emoji que representa o agente>
- **Role:** <papel principal — ex: "Co-piloto de desenvolvimento", "Assistente pessoal">
- **Created:** <data atual em YYYY-MM-DD>

## Mission
<1 parágrafo sobre o que o agente existe pra fazer>

## Owner
<nome do usuário, profissão, contexto>
\`\`\`

## SOUL.md — personalidade
Estrutura sugerida:
\`\`\`
# SOUL

## Tom
<formal ou informal, com exemplos do jeito que o usuário gosta>

## Valores
- <valor 1>
- <valor 2>

## Linguagem
<idioma principal, regras sobre code-switching, gírias permitidas>

## Limites
- <o que evitar>

## Vibe
<1 parágrafo sobre personalidade — humor, sinceridade, etc>
\`\`\`

## USER.md — sobre o usuário
Estrutura sugerida:
\`\`\`
# USER

## Sobre mim
<nome, profissão, contexto pessoal>

## Stack técnica
- <linguagens, frameworks, ferramentas que uso>

## Preferências de trabalho
- <convenções, atalhos, modo de trabalho>

## Projeto atual
<o que estou construindo agora>

## Contexto adicional
<qualquer coisa útil que não cabe acima>
\`\`\`

# Regras
- Use APENAS informação que o usuário forneceu na entrevista — não invente
- Se algum campo não foi mencionado, escreva "(não informado)" em vez de inventar
- Mantenha tom natural, como se o próprio usuário tivesse escrito
- Não use placeholders genéricos tipo "Fill this in"

# Saída obrigatória (apenas JSON válido, sem markdown wrapper)
{
  "IDENTITY.md": "...conteúdo markdown completo...",
  "SOUL.md": "...conteúdo markdown completo...",
  "USER.md": "...conteúdo markdown completo..."
}`;
}
