"use client";

/**
 * Top-of-dashboard banner that flips to amber/red when /api/diagnose/gateway
 * reports a degraded state. Hidden when everything is green so it doesn't
 * add visual noise during normal operation.
 *
 * Polling cadence (60s) is deliberately slower than the health-monitor's
 * own tick (2min) so we don't double up — by the time the banner refreshes,
 * the watchdog has already had time to react. Skipped entirely if the
 * endpoint 401s (user is not logged in to a protected page).
 *
 * The banner is suppressed for the rest of the session after the user
 * dismisses it. State is per-session (sessionStorage) on purpose: a fresh
 * tab should see the warning again, and a deliberate "ignore for now" while
 * focused on other work shouldn't follow the user across reboots.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, XCircle, X, Stethoscope } from "lucide-react";
import Link from "next/link";

const POLL_MS = 60_000;
const SESSION_DISMISS_KEY = "atlasdeck.gatewayHealthBanner.dismissedAt";
const DISMISS_TTL_MS = 30 * 60 * 1000; // a dismissal hides the banner for 30 min, not the whole session

interface BannerPayload {
  severity: "ok" | "warn" | "fail";
  headline: string;
  details: string[];
}

interface DiagPayload {
  config: { dirty: boolean; error?: string };
  pids: Array<{ pid: number }>;
  runtime: string;
  health: { ok: boolean; summary: { fail: number; warn: number; headline: string } } | null;
  watchdog: { started: boolean; circuitOpen: boolean; restartInFlight: boolean };
  watcher: { started: boolean };
}

/**
 * Translate the raw diagnose into the worst-truth banner. Order matters:
 * gateway-dead > circuit-open > config-dirty > telegram-fail > watchdog-down.
 * The user only sees the top issue so they can act, not a wall of warnings.
 */
function evaluate(d: DiagPayload): BannerPayload {
  const details: string[] = [];

  if (d.runtime === "unknown" || d.pids.length === 0) {
    details.push("Gateway OpenClaw não está rodando — auto-restart vai tentar reanimar.");
    return { severity: "fail", headline: "Gateway caiu", details };
  }

  if (d.watchdog.circuitOpen) {
    details.push(
      "Watchdog tentou reiniciar 3x sem sucesso. Investigação manual necessária — abra o diagnóstico.",
    );
    return { severity: "fail", headline: "Auto-recuperação pausada", details };
  }

  if (d.watchdog.restartInFlight) {
    return {
      severity: "warn",
      headline: "Reiniciando gateway",
      details: ["O sistema está reanimando o gateway agora. Aguarde ~30s."],
    };
  }

  if (d.config.error) {
    return {
      severity: "fail",
      headline: "openclaw.json com erro",
      details: [d.config.error],
    };
  }

  if (d.health && d.health.summary.fail > 0) {
    return {
      severity: "fail",
      headline: d.health.summary.headline,
      details: [`${d.health.summary.fail} check(s) crítico(s) no Telegram.`],
    };
  }

  if (d.config.dirty) {
    details.push(
      "openclaw.json tem campos rejeitados pelo schema. Próximo restart do gateway vai limpar automaticamente.",
    );
  }
  if (!d.watcher.started) {
    details.push("File watcher não subiu — atualizações fora do AtlasDeck podem deixar o config sujo até o próximo restart.");
  }
  if (d.health && d.health.summary.warn > 0) {
    details.push(`${d.health.summary.warn} aviso(s) menores no Telegram.`);
  }

  if (details.length > 0) {
    return { severity: "warn", headline: "Algo merece atenção", details };
  }
  return { severity: "ok", headline: "Tudo saudável", details: [] };
}

function readDismissedAt(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.sessionStorage.getItem(SESSION_DISMISS_KEY);
    return raw ? Number(raw) : 0;
  } catch {
    return 0;
  }
}

function writeDismissedAt(ts: number) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SESSION_DISMISS_KEY, String(ts));
  } catch {
    // Storage may be unavailable in private mode — banner will show on next poll
  }
}

export function GatewayHealthBanner() {
  const [banner, setBanner] = useState<BannerPayload | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number>(0);
  const [skipPolling, setSkipPolling] = useState(false);

  useEffect(() => {
    setDismissedAt(readDismissedAt());
  }, []);

  const fetchOnce = useCallback(async () => {
    try {
      const r = await fetch("/api/diagnose/gateway", { cache: "no-store" });
      if (r.status === 401) {
        // Not authenticated (we're on /login or the cookie expired). Stop
        // polling — the banner is a logged-in feature.
        setSkipPolling(true);
        return;
      }
      if (!r.ok) return;
      const j = (await r.json()) as DiagPayload;
      const b = evaluate(j);
      setBanner(b.severity === "ok" ? null : b);
    } catch {
      // Network errors don't surface anything — we don't want to false-alarm
      // when the user briefly loses connectivity.
    }
  }, []);

  useEffect(() => {
    if (skipPolling) return;
    void fetchOnce();
    const id = setInterval(() => void fetchOnce(), POLL_MS);
    return () => clearInterval(id);
  }, [fetchOnce, skipPolling]);

  const dismiss = useCallback(() => {
    const now = Date.now();
    setDismissedAt(now);
    writeDismissedAt(now);
  }, []);

  if (!banner) return null;

  // Suppress only if the user dismissed THIS severity within the TTL.
  // If something escalates (warn → fail), show it again immediately.
  const dismissedRecently = Date.now() - dismissedAt < DISMISS_TTL_MS;
  if (dismissedRecently && banner.severity !== "fail") return null;

  const isFail = banner.severity === "fail";
  const bg = isFail ? "rgba(239, 68, 68, 0.12)" : "rgba(245, 158, 11, 0.12)";
  const border = isFail ? "rgba(239, 68, 68, 0.35)" : "rgba(245, 158, 11, 0.35)";
  const iconColor = isFail ? "text-red-400" : "text-amber-400";
  const Icon = isFail ? XCircle : AlertTriangle;

  return (
    <div
      className="rounded-lg px-4 py-3 mb-4 flex items-start gap-3"
      style={{ backgroundColor: bg, border: `1px solid ${border}` }}
      role="alert"
    >
      <Icon className={`w-5 h-5 mt-0.5 flex-shrink-0 ${iconColor}`} />
      <div className="flex-1 min-w-0">
        <div className="font-medium" style={{ color: "var(--text)" }}>
          {banner.headline}
        </div>
        {banner.details.length > 0 && (
          <ul className="text-sm mt-1 space-y-0.5" style={{ color: "var(--text-muted)" }}>
            {banner.details.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <Link
          href="/settings#gateway-diagnose"
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors"
          style={{
            backgroundColor: "var(--card-elevated, rgba(255,255,255,0.06))",
            color: "var(--text)",
            border: "1px solid var(--border)",
          }}
        >
          <Stethoscope className="w-3.5 h-3.5" />
          Diagnosticar
        </Link>
        <button
          onClick={dismiss}
          className="p-1.5 rounded-lg transition-colors hover:bg-white/10"
          style={{ color: "var(--text-muted)" }}
          title="Esconder por 30 minutos. Vai aparecer de novo se piorar."
          aria-label="Dispensar aviso"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
