/**
 * Quick integrity check for chat-db: round-trip a thread + messages
 * through the schema and verify CRUD, FTS, and stats behave.
 *
 * Run: npx tsx scripts/smoke-test-chat.ts
 */
import {
  createThread,
  appendMessage,
  listThreads,
  listMessages,
  searchMessages,
  deleteThread,
  getThreadStats,
  updateThread,
  updateMessage,
} from "../src/lib/chat-db";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

const thread = createThread({ agent_id: "main", title: "Smoke test", source: "web" });
assert(thread.id, "thread created with id");
assert(thread.title === "Smoke test", "title persisted");

const m1 = appendMessage({ thread_id: thread.id, role: "user", content: "olá jarvis" });
const m2 = appendMessage({
  thread_id: thread.id,
  role: "assistant",
  content: "olá, em que posso ajudar?",
  tokens_in: 5,
  tokens_out: 7,
  cost: 0.001,
});
assert(m1.role === "user", "user message stored");
assert(m2.role === "assistant", "assistant message stored");

const messages = listMessages({ threadId: thread.id });
assert(messages.length === 2, "listMessages returns 2");

const updated = updateMessage(m2.id, { content: "olá! posso ajudar com agenda?" });
assert(updated?.content.includes("agenda"), "updateMessage works");

const hits = searchMessages("agenda");
assert(hits.some((h) => h.thread.id === thread.id), "FTS finds updated content");

const pinned = updateThread(thread.id, { pinned: true });
assert(pinned?.pinned === true, "thread pin works");

const stats = getThreadStats();
assert(stats.totalMessages >= 2, `stats sees messages (got ${stats.totalMessages})`);

const ok = deleteThread(thread.id);
assert(ok, "deleteThread succeeded");

const remaining = listThreads().filter((t) => t.id === thread.id);
assert(remaining.length === 0, "thread removed");

console.log("\n✅ chat-db smoke test passed");
