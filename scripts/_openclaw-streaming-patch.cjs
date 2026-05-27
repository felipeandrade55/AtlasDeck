#!/usr/bin/env node
/**
 * _openclaw-streaming-patch.cjs
 *
 * Helper invocado por `enable-openclaw-streaming.sh`. Lê o openclaw.json,
 * escreve uma cópia patchada em <tmp>, e imprime um JSON de relatório
 * com as mudanças aplicadas — o script bash usa esse relatório para
 * decidir se mostra "já estava correto" ou pede confirmação.
 *
 * Uso interno:
 *   node _openclaw-streaming-patch.cjs <src> <dst>
 *
 * O patch é IDEMPOTENTE: só altera campos que diferem do alvo. Preserva
 * indentação detectada do arquivo original (2 spaces, 4 spaces ou tab).
 */
"use strict";
const fs = require("fs");

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  process.stderr.write("Uso: node _openclaw-streaming-patch.cjs <src> <dst>\n");
  process.exit(2);
}

const raw = fs.readFileSync(src, "utf8");
const data = JSON.parse(raw);

// Detecta indentação do arquivo original para preservar o estilo.
function detectIndent(text) {
  const m = text.match(/^([ \t]+)"/m);
  return m ? m[1] : "  ";
}
const indent = detectIndent(raw);

// agents.defaults é o escopo global que controla streaming de todos os
// agentes. Cria a árvore se não existir.
if (!data.agents || typeof data.agents !== "object" || Array.isArray(data.agents)) {
  data.agents = {};
}
if (
  !data.agents.defaults ||
  typeof data.agents.defaults !== "object" ||
  Array.isArray(data.agents.defaults)
) {
  data.agents.defaults = {};
}

const d = data.agents.defaults;

// Alvo: força streaming token-a-token via WS.
//   blockStreamingDefault: "on"           — habilita streaming em todos os agentes
//   blockStreamingBreak:   "text_end"     — quebra chunk no fim de cada bloco textual
//   blockStreamingChunk:   { minChars: 50, maxChars: 200 }
//                                         — tamanho dos chunks (50-200 chars)
const target = {
  blockStreamingDefault: "on",
  blockStreamingBreak: "text_end",
  blockStreamingChunk: { minChars: 50, maxChars: 200 },
};

// Idempotente: só sobrescreve quando o valor atual difere do alvo.
const changes = [];
for (const key of Object.keys(target)) {
  const want = target[key];
  const have = d[key];
  if (JSON.stringify(have) !== JSON.stringify(want)) {
    changes.push({ key: key, before: have, after: want });
    d[key] = want;
  }
}

fs.writeFileSync(dst, JSON.stringify(data, null, indent) + "\n");

process.stdout.write(
  JSON.stringify({
    changes: changes,
    indentDetected: JSON.stringify(indent),
  }),
);
