/**
 * Minimal typed wrapper around the Telegram Bot API. Lives here so multiple
 * routes (status, diagnose, send) share the same timeout + error shape.
 */

const TG_TIMEOUT_MS = 6000;

export interface TgCallResult<T = unknown> {
  ok: boolean;
  result?: T;
  errorCode?: number;
  description?: string;
  httpStatus?: number;
  networkError?: string;
}

export async function tgCall<T = unknown>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
  timeoutMs: number = TG_TIMEOUT_MS,
): Promise<TgCallResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const httpStatus = res.status;
    let data: { ok?: boolean; result?: T; error_code?: number; description?: string } = {};
    try {
      data = await res.json();
    } catch {
      return { ok: false, httpStatus, description: `Resposta não-JSON (HTTP ${httpStatus})` };
    }
    if (!data.ok) {
      return {
        ok: false,
        httpStatus,
        errorCode: data.error_code,
        description: data.description || `HTTP ${httpStatus}`,
      };
    }
    return { ok: true, result: data.result, httpStatus };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, networkError: msg };
  } finally {
    clearTimeout(timer);
  }
}

export function looksLikeTelegramToken(s: string): boolean {
  return /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(s.trim());
}

export interface TgBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TgWebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  ip_address?: string;
  last_error_date?: number;
  last_error_message?: string;
  last_synchronization_error_date?: number;
  max_connections?: number;
  allowed_updates?: string[];
}
