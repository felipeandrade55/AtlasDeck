/**
 * Tiny client for OpenClaw Gateway's POST /tools/invoke endpoint.
 * Wraps shared-secret auth and JSON marshalling so callers just hand in
 * `{ tool, args }` and get the parsed result back.
 *
 * Per docs/gateway/tools-invoke-http-api.md, the response shape is:
 *   200 → { ok: true, result }
 *   400 → { ok: false, error: { type, message } }
 *   404 → tool denied by policy / not found
 */
import { getOpenClawGatewayInfo } from "./openclaw-config";

export interface ToolInvokeOk<R = unknown> {
  ok: true;
  result: R;
  httpStatus: number;
}

export interface ToolInvokeErr {
  ok: false;
  error: {
    type?: string;
    message: string;
  };
  httpStatus: number;
}

export type ToolInvokeResult<R = unknown> = ToolInvokeOk<R> | ToolInvokeErr;

export interface InvokeToolOpts {
  tool: string;
  args?: Record<string, unknown>;
  action?: string;
  sessionKey?: string;
  timeoutMs?: number;
}

export async function invokeTool<R = unknown>(opts: InvokeToolOpts): Promise<ToolInvokeResult<R>> {
  const info = getOpenClawGatewayInfo();
  const url = `${info.url.replace(/\/$/, "")}/tools/invoke`;

  const body: Record<string, unknown> = {
    tool: opts.tool,
    args: opts.args ?? {},
  };
  if (opts.action) body.action = opts.action;
  if (opts.sessionKey) body.sessionKey = opts.sessionKey;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (info.token) headers.Authorization = `Bearer ${info.token}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 45_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const httpStatus = res.status;
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }

    const obj = (parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}) as
      | Record<string, unknown>
      | undefined;

    if (res.ok && obj && obj.ok === true) {
      return { ok: true, result: obj.result as R, httpStatus };
    }

    const errObj =
      obj && typeof obj.error === "object" && obj.error !== null
        ? (obj.error as { type?: string; message?: string })
        : undefined;

    return {
      ok: false,
      httpStatus,
      error: {
        type: errObj?.type,
        message:
          errObj?.message ||
          (typeof obj?.message === "string" ? (obj.message as string) : `HTTP ${httpStatus}`),
      },
    };
  } catch (e) {
    return {
      ok: false,
      httpStatus: 0,
      error: {
        type: "network",
        message: e instanceof Error ? e.message : String(e),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface WhatsAppLoginResult {
  qrDataUrl?: string;
  message?: string;
  connected?: boolean;
  qr?: boolean;
}

/**
 * Adapter that unwraps the tool's `content` array (markdown text with an
 * embedded `![whatsapp-qr](data:image/png;base64,...)` link) into the
 * shape the AtlasDeck UI cares about — a clean qrDataUrl + flat flags.
 */
function adaptWhatsAppLoginResult(raw: unknown): WhatsAppLoginResult {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const details = (obj.details && typeof obj.details === "object" ? obj.details : {}) as Record<string, unknown>;

  let text = "";
  if (Array.isArray(obj.content)) {
    for (const part of obj.content) {
      if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
        text += `${(part as { text?: string }).text ?? ""}\n`;
      }
    }
  }

  const qrMatch = text.match(/\(data:image\/png;base64,[^\s)]+\)/);
  const qrDataUrl = qrMatch ? qrMatch[0].slice(1, -1) : undefined;

  // First line of the text is the human-readable status from the plugin
  // (e.g. "QR already active. Scan it in WhatsApp → Linked Devices.").
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";

  return {
    qrDataUrl,
    message: firstLine.trim() || undefined,
    connected: typeof details.connected === "boolean" ? details.connected : undefined,
    qr: typeof details.qr === "boolean" ? details.qr : undefined,
  };
}

export async function whatsappLoginStart(opts: {
  accountId?: string;
  force?: boolean;
  timeoutMs?: number;
}): Promise<ToolInvokeResult<WhatsAppLoginResult>> {
  const r = await invokeTool<unknown>({
    tool: "whatsapp_login",
    args: {
      action: "start",
      ...(opts.accountId ? { accountId: opts.accountId } : {}),
      ...(typeof opts.force === "boolean" ? { force: opts.force } : {}),
      ...(typeof opts.timeoutMs === "number" ? { timeoutMs: opts.timeoutMs } : {}),
    },
    timeoutMs: 60_000,
  });
  if (!r.ok) return r;
  return { ok: true, result: adaptWhatsAppLoginResult(r.result), httpStatus: r.httpStatus };
}

export async function whatsappLoginWait(opts: {
  accountId?: string;
  currentQrDataUrl?: string;
  timeoutMs?: number;
}): Promise<ToolInvokeResult<WhatsAppLoginResult>> {
  const r = await invokeTool<unknown>({
    tool: "whatsapp_login",
    args: {
      action: "wait",
      ...(opts.accountId ? { accountId: opts.accountId } : {}),
      ...(opts.currentQrDataUrl ? { currentQrDataUrl: opts.currentQrDataUrl } : {}),
      ...(typeof opts.timeoutMs === "number" ? { timeoutMs: opts.timeoutMs } : {}),
    },
    timeoutMs: 45_000,
  });
  if (!r.ok) return r;
  return { ok: true, result: adaptWhatsAppLoginResult(r.result), httpStatus: r.httpStatus };
}
