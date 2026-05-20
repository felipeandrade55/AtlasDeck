/**
 * Lightweight session JSONL parser tailored for the memory extractor.
 *
 * The richer parser in src/app/api/sessions/route.ts powers the
 * Sessions UI. This module focuses on what the extraction pipeline
 * needs: "exchanges" — user turns paired with the assistant reply
 * plus any tool calls in between — already chunked, deduplicated and
 * size-bounded so the LLM doesn't see redundant tool noise.
 */
import { promises as fs } from "fs";

export interface ExchangeMessage {
  role: "user" | "assistant" | "tool_use" | "tool_result" | "system";
  content: string;
  toolName?: string;
  timestamp?: string;
}

export interface SessionExchange {
  startLine: number;
  endLine: number;
  startTime?: string;
  endTime?: string;
  messages: ExchangeMessage[];
}

export interface ParseOptions {
  /** Start at this line (inclusive). Defaults to 0. */
  fromLine?: number;
  /** Hard cap on exchanges returned. Defaults to no cap. */
  maxExchanges?: number;
  /** Hard cap on text length per message. Defaults to 2000. */
  truncateChars?: number;
}

export interface ParseResult {
  exchanges: SessionExchange[];
  /** Last line successfully consumed (inclusive) — feed back as `fromLine` next time. */
  lastLine: number;
  /** Total bytes seen — useful for telemetry. */
  bytesSeen: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function valueToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        isRecord(item)
          ? valueToText(item.text ?? item.content ?? item.result ?? item)
          : typeof item === "string"
          ? item
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, length - 1).trimEnd()}…`;
}

/**
 * Parse a JSONL session file into discrete exchanges. An exchange
 * starts at a user message and ends at the next user message (or
 * EOF). Tool call/result pairs that lie between are kept together so
 * the extractor has enough context to understand what happened.
 */
export async function parseSessionExchanges(
  filePath: string,
  opts: ParseOptions = {},
): Promise<ParseResult> {
  const fromLine = opts.fromLine ?? 0;
  const maxExchanges = opts.maxExchanges ?? Number.POSITIVE_INFINITY;
  const truncChars = opts.truncateChars ?? 2000;

  const raw = await fs.readFile(filePath, "utf-8");
  const lines = raw.split(/\r?\n/);
  const bytesSeen = Buffer.byteLength(raw, "utf-8");

  const exchanges: SessionExchange[] = [];
  let current: SessionExchange | null = null;
  let lastLineProcessed = fromLine - 1;

  const finalize = () => {
    if (!current) return;
    if (current.messages.length > 0) exchanges.push(current);
    current = null;
  };

  for (let i = fromLine; i < lines.length; i++) {
    lastLineProcessed = i;
    const line = lines[i];
    if (!line) continue;

    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      obj = parsed;
    } catch {
      continue;
    }

    const type = asString(obj.type);
    const timestamp = asString(obj.timestamp);
    if (type !== "message" || !isRecord(obj.message)) continue;

    const msg = obj.message;
    const role = asString(msg.role, "assistant");
    const content = msg.content;

    const addMessage = (m: ExchangeMessage) => {
      if (!current && m.role === "user") {
        current = {
          startLine: i,
          endLine: i,
          startTime: m.timestamp,
          endTime: m.timestamp,
          messages: [],
        };
      }
      if (!current) return;
      current.messages.push(m);
      current.endLine = i;
      current.endTime = m.timestamp ?? current.endTime;
    };

    const flushIfUser = () => {
      if (role === "user" && current && current.messages.length > 0) {
        finalize();
      }
    };

    if (typeof content === "string") {
      flushIfUser();
      addMessage({
        role: role === "user" ? "user" : "assistant",
        content: truncate(content, truncChars),
        timestamp,
      });
    } else if (Array.isArray(content)) {
      let hasFlushed = false;
      for (const block of content) {
        if (!isRecord(block)) continue;
        const blockType = asString(block.type);
        if (blockType === "text") {
          if (!hasFlushed) {
            flushIfUser();
            hasFlushed = true;
          }
          const text = asString(block.text);
          if (text) {
            addMessage({
              role: role === "user" ? "user" : "assistant",
              content: truncate(text, truncChars),
              timestamp,
            });
          }
        } else if (blockType === "tool_use") {
          addMessage({
            role: "tool_use",
            toolName: asString(block.name, "tool"),
            content: truncate(valueToText(block.input), truncChars),
            timestamp,
          });
        } else if (blockType === "tool_result") {
          addMessage({
            role: "tool_result",
            content: truncate(
              valueToText(block.content ?? block.text ?? block.result),
              truncChars,
            ),
            timestamp,
          });
        }
      }
    }

    if (exchanges.length >= maxExchanges) break;
  }

  finalize();

  return {
    exchanges,
    lastLine: lastLineProcessed,
    bytesSeen,
  };
}

/**
 * Render an exchange as plain text for an LLM extraction prompt.
 * Keeps a compact transcript format that gives the model enough
 * structure to attribute observations correctly.
 */
export function renderExchange(exchange: SessionExchange): string {
  return exchange.messages
    .map((m) => {
      switch (m.role) {
        case "user":
          return `USER:\n${m.content}`;
        case "assistant":
          return `ASSISTANT:\n${m.content}`;
        case "tool_use":
          return `TOOL_USE [${m.toolName ?? "tool"}]:\n${m.content}`;
        case "tool_result":
          return `TOOL_RESULT:\n${m.content}`;
        default:
          return `${m.role.toUpperCase()}:\n${m.content}`;
      }
    })
    .join("\n\n");
}
