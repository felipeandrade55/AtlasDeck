import { translateMessage, extractHistoryReplyText } from "@/lib/openclaw-ws-client";

function freshState() {
  return {
    runId: null,
    helloOk: false,
    tokensEmitted: false,
    frameLog: [],
    routingItemIds: new Set<string>(),
    routingItemText: new Map<string, string>(),
    emittedText: "",
    sawRoutingTool: false,
    pendingEmptyFinalAt: 0,
    pendingUsage: null,
    historyReqId: null,
    historyRetried: false,
    observedSessionKey: null,
    agentRunActive: false,
    agentRunEnded: false,
    finalized: false,
    historyAttempts: 0,
    lastHistoryAttemptAt: 0,
  } as Parameters<typeof translateMessage>[1];
}

const RUN = "c5b8dc2d-c63b-4578-acfc-25d26a394eb7";
const SK = "agent:main:web:atlasdeck";

// Frames copied from the user's real session trace (1-13), then the
// plausible continuation shapes the codex app-server emits for the reply.
const realFrames: unknown[] = [
  { type: "event", event: "connect.challenge", payload: { nonce: "b80c8f75", ts: 1 } },
  { type: "res", id: "x", ok: true, payload: { type: "hello-ok", protocol: 4, server: { version: "2026.5.12", connId: "conn-1" } } },
  { type: "res", id: "y", ok: true, payload: { runId: RUN, status: "started" } },
  { type: "event", event: "health", payload: { ok: true, ts: 2, durationMs: 123 } },
  { type: "event", event: "agent", payload: { runId: RUN, stream: "codex_app_server.lifecycle", data: { phase: "startup" }, sessionKey: SK, seq: 1 }, seq: 2 },
  { type: "event", event: "agent", payload: { runId: RUN, stream: "codex_app_server.lifecycle", data: { phase: "thread_ready", threadId: "t1" }, sessionKey: SK, seq: 2 }, seq: 3 },
  { type: "event", event: "agent", payload: { runId: RUN, stream: "codex_app_server.lifecycle", data: { phase: "turn_starting", threadId: "t1" }, sessionKey: SK, seq: 3 }, seq: 4 },
  { type: "event", event: "agent", payload: { runId: RUN, stream: "lifecycle", data: { phase: "start", startedAt: 3 }, sessionKey: SK, seq: 4 }, seq: 5 },
  { type: "event", event: "agent", payload: { runId: RUN, stream: "codex_app_server.item", data: { phase: "started", itemId: "559a", type: "userMessage" }, sessionKey: SK, seq: 5 }, seq: 6 },
  { type: "event", event: "agent", payload: { runId: RUN, stream: "codex_app_server.item", data: { phase: "completed", itemId: "559a", type: "userMessage" }, sessionKey: SK, seq: 6 }, seq: 7 },
  { type: "event", event: "tick", payload: { ts: 4 }, seq: 8 },
  { type: "event", event: "agent", payload: { runId: RUN, stream: "item", data: { itemId: "rs_0ba8", phase: "start", kind: "analysis", title: "Reasoning", status: "running" }, sessionKey: SK, seq: 7 }, seq: 9 },
];

// Candidate continuation shapes for the assistant reply (any ONE of these
// arriving must produce the text):
const replyVariants: Array<{ label: string; frame: unknown }> = [
  {
    label: "codex_app_server.item completed agentMessage with text",
    frame: { type: "event", event: "agent", payload: { runId: RUN, stream: "codex_app_server.item", data: { phase: "completed", itemId: "msg_1", type: "agentMessage", text: "Boa tarde, Felipe! Como posso ajudar?" }, sessionKey: SK } },
  },
  {
    label: "codex_app_server.item completed agentMessage nested item.content",
    frame: { type: "event", event: "agent", payload: { runId: RUN, stream: "codex_app_server.item", data: { phase: "completed", itemId: "msg_2", type: "agentMessage", item: { content: [{ type: "output_text", text: "Boa tarde! Tudo certo por aqui." }] } }, sessionKey: SK } },
  },
  {
    label: "stream item kind message with data.text",
    frame: { type: "event", event: "agent", payload: { runId: RUN, stream: "item", data: { itemId: "msg_3", phase: "finish", kind: "message", text: "Boa tarde! Em que posso ajudar hoje?" }, sessionKey: SK } },
  },
  {
    label: "codex_app_server.item.delta agentMessageDelta",
    frame: { type: "event", event: "agent", payload: { runId: RUN, stream: "codex_app_server.item.delta", data: { itemId: "msg_4", type: "agentMessageDelta", delta: "Boa " }, sessionKey: SK } },
  },
  {
    label: "agentMessage deep-scan fallback (unknown text field)",
    frame: { type: "event", event: "agent", payload: { runId: RUN, stream: "codex_app_server.item", data: { phase: "completed", itemId: "msg_5", type: "agentMessage", visibleText: "Boa tarde! Estou online e operante." }, sessionKey: SK } },
  },
];

let failures = 0;

// 1) The real frames 1-13 must emit ZERO tokens (no reasoning/lifecycle junk).
{
  const state = freshState();
  const tokens: string[] = [];
  for (const f of realFrames) {
    for (const e of translateMessage(f, state)) {
      if (e.type === "token") tokens.push(e.delta);
    }
  }
  if (tokens.length === 0) {
    console.log("PASS  frames 1-13 emit no junk tokens");
  } else {
    failures++;
    console.log("FAIL  frames 1-13 emitted junk:", JSON.stringify(tokens));
  }
}

// 2) Each reply variant must yield its text.
for (const v of replyVariants) {
  const state = freshState();
  for (const f of realFrames) translateMessage(f, state);
  const tokens: string[] = [];
  for (const e of translateMessage(v.frame, state)) {
    if (e.type === "token") tokens.push(e.delta);
  }
  const joined = tokens.join("");
  if (joined.includes("Boa")) {
    console.log(`PASS  ${v.label} -> "${joined.slice(0, 60)}"`);
  } else {
    failures++;
    console.log(`FAIL  ${v.label} -> got "${joined}"`);
  }
}

// 3) Routing tool via codex_app_server.item must register + salvage text.
{
  const state = freshState();
  for (const f of realFrames) translateMessage(f, state);
  const toolStart = { type: "event", event: "agent", payload: { runId: RUN, stream: "codex_app_server.item", data: { phase: "started", itemId: "tool_1", kind: "tool", name: "message", input: {} }, sessionKey: SK } };
  const toolDelta = { type: "event", event: "agent", payload: { runId: RUN, stream: "codex_app_server.item", data: { phase: "delta", itemId: "tool_1", arguments: JSON.stringify({ text: "Boa tarde via tool!" }) }, sessionKey: SK } };
  const evts1 = translateMessage(toolStart, state);
  const evts2 = translateMessage(toolDelta, state);
  const sawToolUse = evts1.some((e) => e.type === "tool_use");
  const salvage = [...evts1, ...evts2].filter((e) => e.type === "token").map((e) => (e as { delta: string }).delta).join("");
  if (sawToolUse && salvage.includes("Boa tarde via tool")) {
    console.log(`PASS  routing tool on codex_app_server.item registered + salvaged "${salvage.slice(0, 40)}"`);
  } else {
    failures++;
    console.log(`FAIL  routing tool: tool_use=${sawToolUse} salvage="${salvage}"`);
  }
}

// 4) REAL tail from the 2026-06-10 session: tool `message` → agentMessage
//    lifecycle WITHOUT text → chat final without text. The empty final
//    must be PARKED (no done event) so the runner can attempt the
//    chat.history recovery, and the routing tool must be flagged.
{
  const state = freshState();
  for (const f of realFrames) translateMessage(f, state);
  const tail: unknown[] = [
    { type: "event", event: "agent", payload: { runId: RUN, stream: "item", data: { itemId: "exec-9832", phase: "start", kind: "tool", title: "Tool", status: "running", name: "message", suppressChannelProgress: true }, sessionKey: SK } },
    { type: "event", event: "agent", payload: { runId: RUN, stream: "codex_app_server.item", data: { phase: "started", itemId: "exec-9832", type: "dynamicToolCall" }, sessionKey: SK } },
    { type: "event", event: "agent", payload: { runId: RUN, stream: "item", data: { itemId: "exec-9832", phase: "end", kind: "tool", title: "Tool", status: "completed", name: "message", suppressChannelProgress: true }, sessionKey: SK } },
    { type: "event", event: "agent", payload: { runId: RUN, stream: "codex_app_server.item", data: { phase: "completed", itemId: "exec-9832", type: "dynamicToolCall" }, sessionKey: SK } },
    { type: "event", event: "agent", payload: { runId: RUN, stream: "codex_app_server.item", data: { phase: "started", itemId: "msg_0ba8", type: "agentMessage" }, sessionKey: SK } },
    { type: "event", event: "agent", payload: { runId: RUN, stream: "codex_app_server.item", data: { phase: "completed", itemId: "msg_0ba8", type: "agentMessage" }, sessionKey: SK } },
    { type: "event", event: "agent", payload: { runId: RUN, stream: "lifecycle", data: { startedAt: 1, endedAt: 2, phase: "end" }, sessionKey: SK } },
  ];
  const finalFrame = { type: "event", event: "chat", payload: { runId: RUN, sessionKey: SK, seq: 19, state: "final" }, seq: 19 };

  const tailEvents = tail.flatMap((f) => translateMessage(f, state));
  const junk = tailEvents.filter((e) => e.type === "token").map((e) => (e as { delta: string }).delta);
  const sawToolUse = tailEvents.some((e) => e.type === "tool_use");
  const finalEvents = translateMessage(finalFrame, state);
  const doneEmitted = finalEvents.some((e) => e.type === "done");
  const st = state as unknown as { pendingEmptyFinalAt: number; sawRoutingTool: boolean };

  if (junk.length === 0 && sawToolUse && !doneEmitted && st.pendingEmptyFinalAt > 0 && st.sawRoutingTool) {
    console.log("PASS  real tail: tool flagged, no junk, empty final parked for chat.history recovery");
  } else {
    failures++;
    console.log(
      `FAIL  real tail: junk=${JSON.stringify(junk)} toolUse=${sawToolUse} done=${doneEmitted} ` +
        `pending=${st.pendingEmptyFinalAt} sawRoutingTool=${st.sawRoutingTool}`,
    );
  }
}

// 5) chat.history reply extraction across plausible response shapes.
{
  const shapes: Array<{ label: string; payload: Record<string, unknown>; expect: string }> = [
    {
      label: "messages[] role assistant content string",
      payload: { messages: [{ role: "user", content: "boa tarde" }, { role: "assistant", content: "Boa tarde! Como posso ajudar?" }] },
      expect: "Boa tarde! Como posso ajudar?",
    },
    {
      label: "messages[] content parts array",
      payload: { messages: [{ role: "assistant", content: [{ type: "text", text: "Olá! Tudo bem?" }] }] },
      expect: "Olá! Tudo bem?",
    },
    {
      label: "history[] role agent text field",
      payload: { history: [{ role: "agent", text: "Resposta recuperada." }] },
      expect: "Resposta recuperada.",
    },
    {
      label: "last assistant EMPTY must NOT resurface older reply",
      payload: { messages: [{ role: "assistant", content: "resposta antiga" }, { role: "user", content: "oi" }, { role: "assistant", content: "" }] },
      expect: "",
    },
  ];
  for (const s of shapes) {
    const got = extractHistoryReplyText(s.payload);
    if (got === s.expect) {
      console.log(`PASS  history: ${s.label}`);
    } else {
      failures++;
      console.log(`FAIL  history: ${s.label} -> "${got}" (esperado "${s.expect}")`);
    }
  }
}

// 6) NEW trace (2026-06-22): premature `chat` final arrives while the codex
//    run only reached `startup` (DIFFERENT runId). It must NOT be treated as
//    terminal — no done, no park — so the socket stays open for the real
//    reply. Then a late agentMessage delivers the text, and the codex run's
//    `lifecycle` end closes the turn cleanly.
{
  const state = freshState();
  const st = state as unknown as {
    pendingEmptyFinalAt: number;
    observedSessionKey: string | null;
    agentRunActive: boolean;
    agentRunEnded: boolean;
    tokensEmitted: boolean;
  };

  // Codex run starts up (own runId), then a premature empty `chat` final
  // with a DIFFERENT runId — exactly the user's trace.
  translateMessage(
    { type: "event", event: "agent", payload: { runId: "52063dab", stream: "codex_app_server.lifecycle", data: { phase: "startup" }, sessionKey: SK, seq: 1 }, seq: 3 },
    state,
  );
  const prematureFinal = translateMessage(
    { type: "event", event: "chat", payload: { runId: "10a1cd36", sessionKey: SK, seq: 1, state: "final" }, seq: 4 },
    state,
  );
  const doneOnPremature = prematureFinal.some((e) => e.type === "done");

  if (
    !doneOnPremature &&
    st.pendingEmptyFinalAt === 0 &&
    st.observedSessionKey === SK &&
    st.agentRunActive &&
    !st.agentRunEnded
  ) {
    console.log("PASS  premature chat final ignored (no done/park, agent-scoped key captured)");
  } else {
    failures++;
    console.log(
      `FAIL  premature final: done=${doneOnPremature} pending=${st.pendingEmptyFinalAt} ` +
        `observedKey=${st.observedSessionKey} active=${st.agentRunActive} ended=${st.agentRunEnded}`,
    );
  }

  // Late agentMessage with the real reply must still emit as a token.
  const lateReply = translateMessage(
    { type: "event", event: "agent", payload: { runId: "52063dab", stream: "codex_app_server.item", data: { phase: "completed", itemId: "msg_z", type: "agentMessage", text: "Na GTX 1080 (8GB) você roda modelos quantizados..." }, sessionKey: SK } },
    state,
  );
  const lateText = lateReply.filter((e) => e.type === "token").map((e) => (e as { delta: string }).delta).join("");

  // The codex run's lifecycle end closes the turn (done), now that text exists.
  const endEvents = translateMessage(
    { type: "event", event: "agent", payload: { runId: "52063dab", stream: "lifecycle", data: { phase: "end", endedAt: 9 }, sessionKey: SK } },
    state,
  );
  const doneOnEnd = endEvents.some((e) => e.type === "done");

  if (lateText.includes("GTX 1080") && doneOnEnd && st.agentRunEnded) {
    console.log(`PASS  late agentMessage emitted + lifecycle end closes turn -> "${lateText.slice(0, 40)}"`);
  } else {
    failures++;
    console.log(`FAIL  late reply: text="${lateText}" doneOnEnd=${doneOnEnd} ended=${st.agentRunEnded}`);
  }
}

// 7) Codex run that ends WITHOUT any text must PARK for chat.history
//    recovery (not emit done), and a done must NOT fire on lifecycle end.
{
  const state = freshState();
  const st = state as unknown as { pendingEmptyFinalAt: number; tokensEmitted: boolean };
  translateMessage(
    { type: "event", event: "agent", payload: { runId: RUN, stream: "codex_app_server.lifecycle", data: { phase: "startup" }, sessionKey: SK }, seq: 3 },
    state,
  );
  const endEvents = translateMessage(
    { type: "event", event: "agent", payload: { runId: RUN, stream: "lifecycle", data: { phase: "end", endedAt: 2 }, sessionKey: SK } },
    state,
  );
  const doneOnEnd = endEvents.some((e) => e.type === "done");
  if (!doneOnEnd && !st.tokensEmitted && st.pendingEmptyFinalAt > 0) {
    console.log("PASS  empty run end parks for chat.history recovery (no premature done)");
  } else {
    failures++;
    console.log(`FAIL  empty run end: done=${doneOnEnd} pending=${st.pendingEmptyFinalAt} tokens=${st.tokensEmitted}`);
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
