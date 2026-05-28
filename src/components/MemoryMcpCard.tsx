"use client";

/**
 * Card that controls the atlasdeck-memory MCP server registration.
 *
 * Designed for non-technical users: at most one button at a time,
 * each step (install/restart/wait) reported as a clear status. The
 * happy path on a fresh boot is "Ativa" + counter — no clicks needed
 * because instrumentation.ts already wrote the mcp.json entry.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Brain,
  CheckCircle,
  AlertCircle,
  Loader2,
  RefreshCw,
  Zap,
  Stethoscope,
  PowerOff,
  XCircle,
} from "lucide-react";

interface StatusResponse {
  configPath: string;
  configExists: boolean;
  serverName: string;
  installed: boolean;
  upToDate: boolean;
  agentSavedCount: number;
  atlasdeckRoot: string;
  otherServers: string[];
  expected: { command: string; args: string[]; env?: Record<string, string> };
  current: { command: string; args: string[]; env?: Record<string, string> } | null;
}

interface ActivateResponse {
  ok: boolean;
  status: StatusResponse;
  install: {
    written: boolean;
    backupPath: string | null;
    preservedServers: string[];
  };
  restart:
    | { skipped: true }
    | { success: boolean; runtime: string; output: string };
  wait:
    | { skipped: true }
    | { ready: boolean; attempts: number; elapsedMs: number; port: number };
  agentSavedCount: number;
  reloadedToolsLikelyVisible: boolean;
  summary: string;
}

interface DiagnoseCheck {
  id: string;
  level: "ok" | "warn" | "fail";
  title: string;
  detail: string;
  fix?: string;
}

interface DiagnoseReport {
  ok: boolean;
  generatedAt: string;
  checks: DiagnoseCheck[];
  spawnProbe: {
    attempted: boolean;
    reachedReady: boolean;
    exitCode: number | null;
    stderrTail: string;
    durationMs: number;
  };
  summary: { ok: number; warn: number; fail: number };
  memoryMd?: {
    path: string;
    exists: boolean;
    hasGuidance: boolean;
    sizeBytes: number;
  };
  toolUseScan?: {
    sessionsScanned: number;
    memoryToolCalls: number;
    perTool: Record<string, number>;
    lastSeenAt: string | null;
  };
}

type Phase = "idle" | "loading" | "activating" | "diagnosing" | "disabling" | "error";

interface Banner {
  kind: "success" | "warn" | "error" | "info";
  text: string;
  detail?: string;
}

export function MemoryMcpCard() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [banner, setBanner] = useState<Banner | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [diagnose, setDiagnose] = useState<DiagnoseReport | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/openclaw/memory-mcp/status", {
        cache: "no-store",
      });
      const json = (await res.json()) as StatusResponse;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(json);
      setPhase("idle");
    } catch (err) {
      setPhase("error");
      setBanner({
        kind: "error",
        text: "Não foi possível ler o status da memória.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activate = useCallback(async () => {
    setPhase("activating");
    setBanner({ kind: "info", text: "Ativando memória avançada…" });
    try {
      const res = await fetch("/api/openclaw/memory-mcp/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "main" }),
      });
      const json = (await res.json()) as ActivateResponse;
      setStatus(json.status);
      setPhase("idle");

      if (json.ok) {
        setBanner({
          kind: "success",
          text: "Memória avançada ativa. O Jarvis agora salva sozinho.",
          detail: json.summary,
        });
      } else if (
        "skipped" in json.restart === false &&
        json.restart.success === false
      ) {
        setBanner({
          kind: "warn",
          text:
            "Config gravada, mas o OpenClaw não pôde ser reiniciado automaticamente. " +
            "Reinicie manualmente para as novas ferramentas aparecerem.",
          detail: `runtime=${
            "runtime" in json.restart ? json.restart.runtime : "?"
          } · ${json.summary}`,
        });
      } else if ("ready" in json.wait && !json.wait.ready) {
        setBanner({
          kind: "warn",
          text:
            "Reiniciado, mas o gateway não voltou a tempo. Verifique os logs do OpenClaw.",
          detail: json.summary,
        });
      } else {
        setBanner({
          kind: "info",
          text: "Tudo certo no AtlasDeck. Aguarde o agente carregar as novas ferramentas.",
          detail: json.summary,
        });
      }
    } catch (err) {
      setPhase("error");
      setBanner({
        kind: "error",
        text: "Falha ao ativar.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const runDiagnose = useCallback(async () => {
    setPhase("diagnosing");
    setBanner({ kind: "info", text: "Rodando diagnóstico…" });
    try {
      const res = await fetch(
        "/api/openclaw/memory-mcp/diagnose?agentId=main",
        { cache: "no-store" },
      );
      const json = (await res.json()) as DiagnoseReport;
      setDiagnose(json);
      setPhase("idle");
      if (json.ok) {
        setBanner({
          kind: "success",
          text: "Diagnóstico: tudo passou.",
          detail: `${json.summary.ok} ok · ${json.summary.warn} alerta · ${json.summary.fail} crítico`,
        });
      } else {
        setBanner({
          kind: json.summary.fail > 0 ? "error" : "warn",
          text:
            json.summary.fail > 0
              ? "Diagnóstico encontrou falhas críticas — veja abaixo."
              : "Diagnóstico com avisos — veja abaixo.",
          detail: `${json.summary.ok} ok · ${json.summary.warn} alerta · ${json.summary.fail} crítico`,
        });
      }
    } catch (err) {
      setPhase("error");
      setBanner({
        kind: "error",
        text: "Falha ao rodar diagnóstico.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const disable = useCallback(async () => {
    if (
      !window.confirm(
        "Remover a entrada atlasdeck-memory do OpenClaw? O Jarvis perderá as " +
          "ferramentas de memória até você reativar. Use isso se ele parou de " +
          "responder por causa do MCP.",
      )
    ) {
      return;
    }
    setPhase("disabling");
    setBanner({ kind: "info", text: "Desativando memória avançada…" });
    try {
      const res = await fetch("/api/openclaw/memory-mcp/install", {
        method: "DELETE",
      });
      const json = (await res.json()) as {
        ok: boolean;
        removed: boolean;
        preservedServers: string[];
      };
      if (!res.ok || !json.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setBanner({
        kind: "warn",
        text:
          "Memória avançada removida do mcp.json. Reinicie o OpenClaw " +
          "manualmente (botão no Doctor do Telegram → Reiniciar gateway) " +
          "para o Jarvis voltar ao estado anterior.",
        detail: json.removed
          ? `Outros MCPs preservados: ${
              json.preservedServers.length || "nenhum"
            }`
          : "Entrada já não estava registrada.",
      });
      await refresh();
    } catch (err) {
      setPhase("error");
      setBanner({
        kind: "error",
        text: "Falha ao desativar.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, [refresh]);

  if (!status && phase === "loading") {
    return (
      <div
        className="rounded-xl p-6 animate-pulse"
        style={{ backgroundColor: "var(--card)" }}
      >
        <div
          className="h-6 rounded w-1/3 mb-4"
          style={{ backgroundColor: "var(--card-elevated, var(--border))" }}
        ></div>
        <div
          className="h-16 rounded"
          style={{ backgroundColor: "var(--card-elevated, var(--border))" }}
        ></div>
      </div>
    );
  }

  const fullyActive = status?.installed && status?.upToDate;
  const installedButStale = status?.installed && !status?.upToDate;
  const notInstalled = !status?.installed;

  const headerLabel = fullyActive
    ? "Ativa"
    : installedButStale
    ? "Precisa atualizar"
    : "Inativa";
  const headerColor = fullyActive
    ? "#34d399"
    : installedButStale
    ? "#facc15"
    : "#fca5a5";
  const HeaderIcon = fullyActive ? CheckCircle : AlertCircle;

  const primaryLabel = notInstalled
    ? "Ativar memória avançada"
    : installedButStale
    ? "Atualizar e recarregar"
    : "Reverificar";
  const PrimaryIcon = notInstalled || installedButStale ? Zap : RefreshCw;

  const bannerColor: Record<Banner["kind"], string> = {
    success: "#34d399",
    warn: "#facc15",
    error: "#fca5a5",
    info: "#93c5fd",
  };

  return (
    <div className="rounded-xl p-6" style={{ backgroundColor: "var(--card)" }}>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2
            className="text-xl font-semibold mb-1 flex items-center gap-2"
            style={{
              color: "var(--text-primary)",
              fontFamily: "var(--font-heading)",
            }}
          >
            <Brain className="w-5 h-5" style={{ color: "var(--accent)" }} />
            Memória avançada
          </h2>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            Dá ao Jarvis ferramentas reais para salvar, buscar e atualizar
            memórias automaticamente — sem você precisar pedir.
          </p>
        </div>
        <div className="flex items-center gap-2" style={{ color: headerColor }}>
          <HeaderIcon className="w-5 h-5" />
          <span className="text-sm font-medium">{headerLabel}</span>
        </div>
      </div>

      <div
        className="rounded-lg p-3 mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
        style={{
          backgroundColor: "var(--card-elevated, rgba(255,255,255,0.04))",
          color: "var(--text-secondary)",
        }}
      >
        <span>
          Memórias salvas pelo Jarvis:{" "}
          <strong style={{ color: "var(--text-primary)" }}>
            {status?.agentSavedCount ?? 0}
          </strong>
        </span>
        <span>
          Config:{" "}
          <strong
            style={{ color: status?.configExists ? "#34d399" : "#facc15" }}
          >
            {status?.configExists ? "presente" : "ausente"}
          </strong>
        </span>
        {status && status.otherServers.length > 0 && (
          <span>
            Outros MCPs:{" "}
            <strong style={{ color: "var(--text-primary)" }}>
              {status.otherServers.length}
            </strong>
          </span>
        )}
      </div>

      {banner && (
        <div
          className="rounded-lg p-3 mb-3 text-sm"
          style={{
            backgroundColor: `${bannerColor[banner.kind]}1f`,
            border: `1px solid ${bannerColor[banner.kind]}55`,
            color: bannerColor[banner.kind],
          }}
        >
          <div>{banner.text}</div>
          {banner.detail && (
            <div
              className="mt-1 text-xs font-mono"
              style={{ color: "var(--text-muted)" }}
            >
              {banner.detail}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={activate}
          disabled={phase !== "idle" && phase !== "loading"}
          className="flex items-center gap-2 px-4 py-2 rounded-lg transition-colors disabled:opacity-50 text-sm font-medium"
          style={{
            backgroundColor:
              notInstalled || installedButStale
                ? "rgba(139,92,246,0.18)"
                : "var(--card-elevated, rgba(255,255,255,0.06))",
            color:
              notInstalled || installedButStale ? "#c4b5fd" : "var(--text-primary)",
            border:
              notInstalled || installedButStale
                ? "1px solid rgba(139,92,246,0.4)"
                : "1px solid var(--border)",
          }}
        >
          {phase === "activating" ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <PrimaryIcon className="w-4 h-4" />
          )}
          {phase === "activating" ? "Ativando…" : primaryLabel}
        </button>

        <button
          onClick={runDiagnose}
          disabled={phase !== "idle" && phase !== "loading"}
          className="flex items-center gap-2 px-3 py-2 rounded-lg transition-colors disabled:opacity-50 text-sm"
          style={{
            backgroundColor: "rgba(250,204,21,0.12)",
            color: "#fde047",
            border: "1px solid rgba(250,204,21,0.35)",
          }}
          title="Verifica config, paths, e tenta subir o servidor MCP"
        >
          {phase === "diagnosing" ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Stethoscope className="w-4 h-4" />
          )}
          Diagnosticar
        </button>

        {status?.installed && (
          <button
            onClick={disable}
            disabled={phase !== "idle" && phase !== "loading"}
            className="flex items-center gap-2 px-3 py-2 rounded-lg transition-colors disabled:opacity-50 text-sm"
            style={{
              color: "#fca5a5",
              border: "1px solid rgba(248,113,113,0.35)",
              backgroundColor: "rgba(248,113,113,0.08)",
            }}
            title="Remove o entry do mcp.json (use se o Jarvis parou)"
          >
            {phase === "disabling" ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <PowerOff className="w-4 h-4" />
            )}
            Desativar
          </button>
        )}

        <button
          onClick={() => setShowDetails((v) => !v)}
          className="px-3 py-2 rounded-lg text-xs ml-auto"
          style={{
            color: "var(--text-muted)",
            border: "1px solid var(--border)",
          }}
        >
          {showDetails ? "Ocultar detalhes" : "Detalhes técnicos"}
        </button>
      </div>

      {diagnose && (
        <div className="mt-4 space-y-2">
          {diagnose.checks.map((c) => {
            const tone =
              c.level === "ok"
                ? { color: "#34d399", Icon: CheckCircle }
                : c.level === "warn"
                ? { color: "#facc15", Icon: AlertCircle }
                : { color: "#fca5a5", Icon: XCircle };
            const ToneIcon = tone.Icon;
            return (
              <div
                key={c.id}
                className="rounded-lg p-3 text-sm"
                style={{
                  backgroundColor: `${tone.color}10`,
                  border: `1px solid ${tone.color}33`,
                }}
              >
                <div className="flex items-start gap-2">
                  <ToneIcon
                    className="w-4 h-4 mt-0.5 shrink-0"
                    style={{ color: tone.color }}
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className="font-medium"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {c.title}
                    </div>
                    <div
                      className="text-xs mt-0.5 whitespace-pre-wrap break-words"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {c.detail}
                    </div>
                    {c.fix && (
                      <div
                        className="text-xs mt-1"
                        style={{ color: "var(--text-muted)" }}
                      >
                        → {c.fix}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {diagnose.toolUseScan && (
            <div
              className="rounded-lg p-3 text-xs"
              style={{
                backgroundColor: "var(--card-elevated, rgba(255,255,255,0.03))",
                border: "1px solid var(--border)",
                color: "var(--text-secondary)",
              }}
            >
              <div className="font-medium mb-1" style={{ color: "var(--text-primary)" }}>
                Uso real (últimas 24h)
              </div>
              <div>
                Sessões varridas:{" "}
                <strong>{diagnose.toolUseScan.sessionsScanned}</strong>{" "}
                · Chamadas a memory_*:{" "}
                <strong
                  style={{
                    color:
                      diagnose.toolUseScan.memoryToolCalls > 0
                        ? "#34d399"
                        : "#fca5a5",
                  }}
                >
                  {diagnose.toolUseScan.memoryToolCalls}
                </strong>
              </div>
              {diagnose.toolUseScan.lastSeenAt && (
                <div>
                  Última chamada: {diagnose.toolUseScan.lastSeenAt}
                </div>
              )}
              {Object.keys(diagnose.toolUseScan.perTool).length > 0 && (
                <div>
                  Por tool: {JSON.stringify(diagnose.toolUseScan.perTool)}
                </div>
              )}
            </div>
          )}
          {diagnose.memoryMd && (
            <div
              className="rounded-lg p-3 text-xs"
              style={{
                backgroundColor: "var(--card-elevated, rgba(255,255,255,0.03))",
                border: "1px solid var(--border)",
                color: "var(--text-secondary)",
              }}
            >
              <div className="font-medium mb-1" style={{ color: "var(--text-primary)" }}>
                MEMORY.md do agente principal
              </div>
              <div className="font-mono break-all">{diagnose.memoryMd.path}</div>
              <div>
                {diagnose.memoryMd.exists
                  ? `${diagnose.memoryMd.sizeBytes} bytes · `
                  : "ausente · "}
                guidance de tools:{" "}
                <strong
                  style={{
                    color: diagnose.memoryMd.hasGuidance ? "#34d399" : "#fca5a5",
                  }}
                >
                  {diagnose.memoryMd.hasGuidance ? "presente" : "AUSENTE"}
                </strong>
              </div>
            </div>
          )}
          {diagnose.spawnProbe.attempted && diagnose.spawnProbe.stderrTail && (
            <details
              className="rounded-lg p-3 text-xs"
              style={{
                backgroundColor: "var(--card-elevated, rgba(255,255,255,0.03))",
                border: "1px solid var(--border)",
              }}
            >
              <summary
                className="cursor-pointer font-medium"
                style={{ color: "var(--text-secondary)" }}
              >
                stderr do MCP server ({diagnose.spawnProbe.durationMs}ms)
              </summary>
              <pre
                className="mt-2 whitespace-pre-wrap font-mono"
                style={{ color: "var(--text-muted)" }}
              >
                {diagnose.spawnProbe.stderrTail}
              </pre>
            </details>
          )}
        </div>
      )}

      {showDetails && status && (
        <div
          className="mt-4 rounded-lg p-3 text-xs font-mono space-y-1"
          style={{
            backgroundColor: "var(--card-elevated, rgba(255,255,255,0.03))",
            color: "var(--text-muted)",
            border: "1px solid var(--border)",
          }}
        >
          <div>configPath: {status.configPath}</div>
          <div>atlasdeckRoot: {status.atlasdeckRoot}</div>
          <div>serverName: {status.serverName}</div>
          <div>
            installed: {String(status.installed)} · upToDate:{" "}
            {String(status.upToDate)}
          </div>
          {status.current && (
            <div>
              current: {status.current.command} {status.current.args.join(" ")}
            </div>
          )}
          <div>
            expected: {status.expected.command} {status.expected.args.join(" ")}
          </div>
        </div>
      )}
    </div>
  );
}
