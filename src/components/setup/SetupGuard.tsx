"use client";

/**
 * Non-blocking setup hint. Polls /api/setup/status on mount + on every
 * pathname change; if the wizard is still pending it shows a dismissible
 * banner suggesting /welcome. It never forces navigation — the user can
 * keep using the rest of the app while setup remains incomplete.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";

type SetupStep = "install" | "ai" | "interview" | "telegram" | "done";

const STEP_LABEL: Record<SetupStep, string> = {
  install: "instalar OpenClaw",
  ai: "configurar modelo de IA",
  interview: "completar a entrevista inicial",
  telegram: "conectar Telegram",
  done: "concluído",
};

// Per-tab dismissal: we want to nudge again on the next browser session,
// but not nag while the operator is exploring the app right now.
const DISMISS_KEY = "atlasdeck:setup-banner-dismissed";

export function SetupGuard() {
  const pathname = usePathname();
  const [step, setStep] = useState<SetupStep | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      setDismissed(sessionStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      // sessionStorage may be unavailable (SSR, privacy mode) — fine
    }
  }, []);

  useEffect(() => {
    if (pathname === "/welcome") {
      setStep(null);
      return;
    }
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/setup/status", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) return;
        const json = (await res.json()) as {
          setup?: { step?: SetupStep; completedAt?: string | null };
        };
        if (json?.setup?.completedAt) {
          setStep(null);
        } else {
          setStep(json?.setup?.step ?? "install");
        }
      } catch {
        // ignore — banner just won't show this tick
      }
    })();
    return () => controller.abort();
  }, [pathname]);

  if (!step || step === "done" || dismissed || pathname === "/welcome") {
    return null;
  }

  return (
    <div style={bannerStyle} role="status">
      <span style={textStyle}>
        <strong>⚙ Setup pendente</strong> — próximo passo: <em>{STEP_LABEL[step]}</em>.
        Você pode continuar usando o AtlasDeck normalmente.
      </span>
      <span style={actionsStyle}>
        <Link href="/welcome" style={ctaStyle}>
          Abrir wizard
        </Link>
        <button
          type="button"
          onClick={() => {
            try {
              sessionStorage.setItem(DISMISS_KEY, "1");
            } catch {}
            setDismissed(true);
          }}
          style={dismissStyle}
          title="Esconder até a próxima sessão"
          aria-label="Dispensar"
        >
          ✕
        </button>
      </span>
    </div>
  );
}

const bannerStyle: CSSProperties = {
  position: "fixed",
  top: 48,
  left: 68,
  right: 0,
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 16px",
  background: "rgba(245, 158, 11, 0.12)",
  borderBottom: "1px solid #f59e0b",
  color: "#f59e0b",
  fontSize: 12,
  lineHeight: 1.4,
};

const textStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const actionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexShrink: 0,
};

const ctaStyle: CSSProperties = {
  background: "#f59e0b",
  color: "#1f1408",
  borderRadius: 4,
  padding: "4px 10px",
  fontSize: 11,
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

const dismissStyle: CSSProperties = {
  background: "transparent",
  border: "1px solid #f59e0b",
  borderRadius: 4,
  color: "#f59e0b",
  fontSize: 11,
  padding: "2px 8px",
  cursor: "pointer",
};
