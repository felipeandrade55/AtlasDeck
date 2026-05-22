import { parseAgentEnvelope } from "../src/lib/openclaw-runner";

const sample = JSON.stringify({
  runId: "4cc27c1a-6fc2-4cd1-8f9f-6c81f3b9370e",
  status: "ok",
  summary: "completed",
  result: {
    payloads: [{ text: "Bom dia, Felipe. O que vamos resolver agora?", mediaUrl: null }],
    meta: {
      agentMeta: {
        sessionId: "57b5ed52-cd86-4f19-a7fa-698378f64199",
        model: "gpt-5.4",
        usage: { input: 17619, output: 38, cacheRead: 1536, total: 19193 },
      },
      finalAssistantVisibleText: "Bom dia, Felipe. O que vamos resolver agora?",
    },
  },
});

const parsed = parseAgentEnvelope(sample);
const assert = (cond: unknown, msg: string) => {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
};

assert(parsed.reply === "Bom dia, Felipe. O que vamos resolver agora?", "reply extracted from payloads[0].text");
assert(parsed.sessionId === "57b5ed52-cd86-4f19-a7fa-698378f64199", "sessionId extracted");
assert(parsed.usage?.tokensIn === 17619, `tokensIn=17619 (got ${parsed.usage?.tokensIn})`);
assert(parsed.usage?.tokensOut === 38, `tokensOut=38 (got ${parsed.usage?.tokensOut})`);
assert(parsed.usage?.model === "gpt-5.4", `model=gpt-5.4 (got ${parsed.usage?.model})`);

// Empty / garbage cases
assert(parseAgentEnvelope("").reply === null, "empty returns null reply");
assert(parseAgentEnvelope("not json").reply === null, "non-json returns null reply");
assert(parseAgentEnvelope('{"foo":1}').reply === null, "unknown shape returns null reply");

// Flat-envelope alias (Ollama or other providers)
assert(parseAgentEnvelope('{"response":"oi"}').reply === "oi", "fallback to flat 'response'");

console.log("\n✅ envelope parser ok");
