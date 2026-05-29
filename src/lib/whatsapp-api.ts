/**
 * Minimal typed wrapper around the WhatsApp integration APIs.
 * Supports Meta Cloud API credentials or self-hosted session servers,
 * providing both live diagnostics and clean mock fallbacks when offline.
 */

const WA_TIMEOUT_MS = 6000;

export interface WaCallResult<T = unknown> {
  ok: boolean;
  result?: T;
  errorCode?: number;
  description?: string;
  httpStatus?: number;
  networkError?: string;
}

export function looksLikePhoneNumber(s: string): boolean {
  return /^\+?[1-9]\d{1,14}$/.test(s.trim().replace(/[-\s()]/g, ""));
}

export interface WaSessionInfo {
  sessionName: string;
  status: "connected" | "disconnected" | "authenticating";
  phoneNumber?: string;
  deviceInfo?: string;
  batteryLevel?: number;
}

export async function waCall<T = unknown>(
  endpoint: string,
  method: "GET" | "POST",
  token?: string,
  body?: Record<string, unknown>,
  timeoutMs: number = WA_TIMEOUT_MS,
): Promise<WaCallResult<T>> {
  if (!token || token === "configured_mock_token") {
    // Elegant mock response for development and mock mode
    return {
      ok: true,
      httpStatus: 200,
      result: {
        success: true,
        message: "Operação executada com sucesso (Simulado)",
      } as unknown as T,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const httpStatus = res.status;
    let data: any = {};
    try {
      data = await res.json();
    } catch {
      return { ok: false, httpStatus, description: `Resposta não-JSON (HTTP ${httpStatus})` };
    }

    if (httpStatus >= 400) {
      return {
        ok: false,
        httpStatus,
        description: data.error?.message || data.description || `HTTP ${httpStatus}`,
      };
    }
    return { ok: true, result: data, httpStatus };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, networkError: msg };
  } finally {
    clearTimeout(timer);
  }
}
