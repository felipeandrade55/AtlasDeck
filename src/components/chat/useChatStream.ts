"use client";

import { useCallback, useRef, useState } from "react";
import type { ChatMessage } from "./types";

export interface StreamMeta {
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
  agentId: string;
}

export interface SendOptions {
  threadId?: string;
  agentId: string;
  message: string;
  workspace?: string | null;
  /**
   * When true, the server appends a routing hint to the prompt asking
   * the agent to reply inline (used by the "Forçar resposta direta"
   * button after a stub-reply is detected).
   */
  forceInline?: boolean;
  thinking?: string;
  fastMode?: boolean;
  onMeta?: (meta: StreamMeta) => void;
  onProvider?: (payload: { provider: string; detail?: string; buffered?: boolean }) => void;
  onToken?: (delta: string) => void;
  onToolUse?: (payload: { id?: string; name: string; input: unknown }) => void;
  onToolResult?: (payload: { id?: string; output: string }) => void;
  onUsage?: (payload: { tokensIn: number; tokensOut: number; cost?: number; model?: string }) => void;
  onError?: (message: string, code?: string) => void;
  onDone?: (payload: { assistantMessageId: string; content: string; tokensIn: number; tokensOut: number; cost: number; provider?: string; providerDetail?: string; buffered?: boolean; stubReply?: boolean; heartbeatLeak?: boolean }) => void;
}

/**
 * SSE consumer for /api/chat/stream. Parses each event by name and
 * dispatches to the provided callbacks. Aborts the request when the
 * caller invokes stop().
 */
export function useChatStream() {
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  }, []);

  const send = useCallback(async (opts: SendOptions) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setIsStreaming(true);

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: opts.threadId,
          agentId: opts.agentId,
          message: opts.message,
          workspace: opts.workspace ?? undefined,
          forceInline: opts.forceInline === true ? true : undefined,
          thinking: opts.thinking ?? undefined,
          fastMode: opts.fastMode !== undefined ? opts.fastMode : undefined,
        }),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        opts.onError?.(`Erro ${res.status}: ${await res.text()}`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by blank lines
        let blankIdx: number;
        while ((blankIdx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, blankIdx);
          buffer = buffer.slice(blankIdx + 2);
          parseEvent(raw, opts);
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        // Browser fetch() rejects with "Failed to fetch" on every kind of
        // network failure (DNS, offline, CORS, TLS, dropped TCP). The
        // bare message is useless to operators, so we wrap it with the
        // most likely culprit so the chat banner is actionable.
        const raw = (err as Error).message || "erro desconhecido";
        const enriched =
          raw === "Failed to fetch"
            ? "Sem conexão com o servidor (Failed to fetch). Verifique sua internet, " +
              "se o AtlasDeck está rodando e se nada está bloqueando /api/chat/stream."
            : raw;
        opts.onError?.(enriched);
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, []);

  return { send, stop, isStreaming };
}

function parseEvent(raw: string, opts: SendOptions) {
  let eventName = "message";
  let dataLine = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
  }
  if (!dataLine) return;

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(dataLine) as Record<string, unknown>;
  } catch {
    return;
  }

  switch (eventName) {
    case "meta":
      opts.onMeta?.(data as unknown as StreamMeta);
      break;
    case "provider":
      opts.onProvider?.({
        provider: String(data.provider ?? "unknown"),
        detail: data.detail as string | undefined,
        buffered: data.buffered === true,
      });
      break;
    case "token":
      opts.onToken?.(String(data.delta ?? ""));
      break;
    case "tool_use":
      opts.onToolUse?.({
        id: data.id as string | undefined,
        name: String(data.name ?? "tool"),
        input: data.input,
      });
      break;
    case "tool_result":
      opts.onToolResult?.({
        id: data.id as string | undefined,
        output: String(data.output ?? ""),
      });
      break;
    case "usage":
      opts.onUsage?.({
        tokensIn: Number(data.tokensIn ?? 0),
        tokensOut: Number(data.tokensOut ?? 0),
        cost: data.cost != null ? Number(data.cost) : undefined,
        model: data.model as string | undefined,
      });
      break;
    case "error":
      opts.onError?.(
        String(data.message ?? "Erro desconhecido"),
        data.code != null ? String(data.code) : undefined,
      );
      break;
    case "done":
      opts.onDone?.({
        assistantMessageId: String(data.assistantMessageId ?? ""),
        content: String(data.content ?? ""),
        tokensIn: Number(data.tokensIn ?? 0),
        tokensOut: Number(data.tokensOut ?? 0),
        cost: Number(data.cost ?? 0),
        provider: data.provider as string | undefined,
        providerDetail: data.providerDetail as string | undefined,
        buffered: data.buffered === true,
        stubReply: data.stubReply === true,
        heartbeatLeak: data.heartbeatLeak === true,
      });
      break;
  }
}

export type { ChatMessage };
