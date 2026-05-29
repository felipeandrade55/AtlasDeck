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
  legacyMcpJsonExists?: boolean;
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
  openclawJson?: {
    path: string;
    exists: boolean;
    parseable: boolean;
    sizeBytes: number;
    mcpServersFound: string[];
    atlasdeckMemoryEntry: {
      command: string;
      args: string[];
      envKeys: string[];
    } | null;
    acpxBridgeEnabled: boolean | null;
    detectedAt: "mcp.servers" | "mcp_servers" | "agents-inline" | "none";
  };
  memoryMd?: {
    path: string;
    pathSource?: "openclaw.json" | "atlasdeck-config" | "fallback";
    exists: boolean;
    hasGuidance: boolean;
    sizeBytes: number;
  };
  toolUseScan?: {
    sessionsScanned: number;
    memoryToolCalls: number;
    totalToolCalls: number;
    perTool: Record<string, number>;
    allTools: Record<string, number>;
    lastSeenAt: string | null;
    sessionsWithToolListing: number;
    sessions: Array<{
      sessionId: string;
      mtime: string;
      sizeBytes: number;
      userMessageCount: number;
      lastUserText: string | null;
      hasAnyToolUse: boolean;
      mentionsMemoryTools: boolean;
    }>;
  };
}

type Phase =
  | "idle"
  | "loading"
  | "activating"
  | "diagnosing"
  | "disabling"
  | "enabling-bridge"
  | "restarting"
  | "error";

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

  const restartGateway = useCallback(async () => {
    setPhase("restarting");
    setBanner({
      kind: "info",
      text: "Reiniciando o gateway do OpenClaw…",
    });
    try {
      const res = await fetch("/api/openclaw/memory-mcp/restart-gateway", {
        method: "POST",
      });
      const json = (await res.json()) as {
        ok: boolean;
        restart: { success: boolean; runtime: string; output: string };
        wait: { skipped: true } | { ready: boolean; elapsedMs: number };
        summary: string;
      };
      // Refresh diagnose to show updated session list once new
      // sessions land.
      const diagRes = await fetch(
        "/api/openclaw/memory-mcp/diagnose?agentId=main",
        { cache: "no-store" },
      );
      const diagJson = (await diagRes.json()) as DiagnoseReport;
      setDiagnose(diagJson);
      setPhase("idle");
      setBanner({
        kind: json.ok ? "success" : "warn",
        text: json.ok
          ? "Gateway reiniciado. Abra uma conversa NOVA no Telegram pra o LLM ler o system prompt com as tools."
          : "Reinício teve problemas — veja detalhe.",
        detail: json.summary,
      });
    } catch (err) {
      setPhase("error");
      setBanner({
        kind: "error",
        text: "Falha ao reiniciar gateway.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const enableAcpxBridge = useCallback(async () => {
    setPhase("enabling-bridge");
    setBanner({
      kind: "info",
      text: "Habilitando ACPX bridge (deixa MCP tools alcançarem o agente)…",
    });
    try {
      const res = await fetch("/api/openclaw/memory-mcp/acpx-bridge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        changed: boolean;
        before: unknown;
        after: boolean;
        persisted: boolean | null;
        persistedValue?: unknown;
        error?: string;
      };
      if (!json.ok) {
        setPhase("error");
        setBanner({
          kind: "error",
          text: "Não consegui editar o openclaw.json.",
          detail: json.error,
        });
        return;
      }
      // Auto-refresh the diagnose so the user sees the bridge flip from
      // "não configurado" → "ativo" without an extra click. Without this
      // the button stays visible (acpxBridgeEnabled stale) and the user
      // thinks nothing happened.
      const diagRes = await fetch(
        "/api/openclaw/memory-mcp/diagnose?agentId=main",
        { cache: "no-store" },
      );
      const diagJson = (await diagRes.json()) as DiagnoseReport;
      setDiagnose(diagJson);
      setPhase("idle");

      if (json.persisted === false) {
        setBanner({
          kind: "warn",
          text:
            "Escrevi pluginToolsMcpBridge=true mas, ao reler o arquivo, " +
            "o valor não persistiu — outro processo (gateway watchdog ou " +
            "openclaw doctor) está revertendo. Veja detalhe.",
          detail: `valor lido após write: ${JSON.stringify(json.persistedValue)}`,
        });
      } else {
        setBanner({
          kind: "success",
          text: json.changed
            ? "ACPX bridge ativado e confirmado em disco. Agora clique em Reverificar pra reiniciar o gateway."
            : "ACPX bridge já estava ativo.",
          detail: `before=${JSON.stringify(json.before)} · after=${json.after} · persistido=${json.persisted}`,
        });
      }
    } catch (err) {
      setPhase("error");
      setBanner({
        kind: "error",
        text: "Falha ao habilitar ACPX bridge.",
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

        <button
          onClick={restartGateway}
          disabled={phase !== "idle" && phase !== "loading"}
          className="flex items-center gap-2 px-3 py-2 rounded-lg transition-colors disabled:opacity-50 text-sm"
          style={{
            backgroundColor: "rgba(56,189,248,0.12)",
            color: "#7dd3fc",
            border: "1px solid rgba(56,189,248,0.35)",
          }}
          title="Força reload do gateway sem tocar config — necessário após mexer no openclaw.json fora do Reverificar"
        >
          {phase === "restarting" ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          Reiniciar gateway
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
                · Total de tool calls:{" "}
                <strong>{diagnose.toolUseScan.totalToolCalls}</strong>{" "}
                · memory_*:{" "}
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
                  Última chamada a memory_*: {diagnose.toolUseScan.lastSeenAt}
                </div>
              )}
              {diagnose.toolUseScan.sessions.length > 0 && (
                <div className="mt-2">
                  <span style={{ color: "var(--text-muted)" }}>
                    Sessões (mais novas primeiro · tools listadas:{" "}
                    {diagnose.toolUseScan.sessionsWithToolListing}/
                    {diagnose.toolUseScan.sessions.length}):
                  </span>
                  <ul className="mt-1 space-y-1">
                    {diagnose.toolUseScan.sessions.slice(0, 8).map((s) => (
                      <li
                        key={s.sessionId + s.mtime}
                        className="rounded p-1.5"
                        style={{
                          backgroundColor: s.userMessageCount > 0
                            ? "rgba(255,255,255,0.03)"
                            : "transparent",
                        }}
                      >
                        <div className="flex flex-wrap items-center gap-x-2">
                          <span className="font-mono" style={{ color: "var(--text-primary)" }}>
                            {s.sessionId}
                          </span>
                          <span style={{ color: "var(--text-muted)" }}>
                            user msgs:{" "}
                            <strong
                              style={{
                                color: s.userMessageCount > 0 ? "#34d399" : "#94a3b8",
                              }}
                            >
                              {s.userMessageCount}
                            </strong>
                          </span>
                          <span style={{ color: "var(--text-muted)" }}>
                            tools listadas:{" "}
                            <strong
                              style={{
                                color: s.mentionsMemoryTools ? "#34d399" : "#fca5a5",
                              }}
                            >
                              {s.mentionsMemoryTools ? "sim" : "não"}
                            </strong>
                          </span>
                          <span style={{ color: "var(--text-muted)" }}>
                            chamou tool:{" "}
                            <strong
                              style={{
                                color: s.hasAnyToolUse ? "#34d399" : "#94a3b8",
                              }}
                            >
                              {s.hasAnyToolUse ? "sim" : "não"}
                            </strong>
                          </span>
                        </div>
                        {s.lastUserText && (
                          <div
                            className="text-xs italic mt-0.5"
                            style={{ color: "var(--text-secondary)" }}
                          >
                            “{s.lastUserText}”
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {Object.keys(diagnose.toolUseScan.allTools).length > 0 && (
                <div className="mt-1">
                  <span style={{ color: "var(--text-muted)" }}>
                    Top tools que o Jarvis ESTÁ chamando:
                  </span>
                  <ul className="ml-3 mt-0.5">
                    {Object.entries(diagnose.toolUseScan.allTools)
                      .sort(([, a], [, b]) => b - a)
                      .slice(0, 8)
                      .map(([name, count]) => (
                        <li key={name}>
                          <span
                            className="font-mono"
                            style={{
                              color: name.startsWith("memory_")
                                ? "#34d399"
                                : "var(--text-primary)",
                            }}
                          >
                            {name}
                          </span>{" "}
                          × {count}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {diagnose.openclawJson && (
            <div
              className="rounded-lg p-3 text-xs"
              style={{
                backgroundColor: "var(--card-elevated, rgba(255,255,255,0.03))",
                border: "1px solid var(--border)",
                color: "var(--text-secondary)",
              }}
            >
              <div className="font-medium mb-1" style={{ color: "var(--text-primary)" }}>
                openclaw.json (fonte autoritativa)
              </div>
              <div className="font-mono break-all">{diagnose.openclawJson.path}</div>
              <div>
                {diagnose.openclawJson.exists
                  ? `${diagnose.openclawJson.sizeBytes} bytes`
                  : "ausente"}{" "}
                · servidores MCP: {diagnose.openclawJson.mcpServersFound.length || 0}{" "}
                {diagnose.openclawJson.mcpServersFound.length > 0 &&
                  `(${diagnose.openclawJson.mcpServersFound.join(", ")})`}
              </div>
              <div>
                Entry detectado em:{" "}
                <strong
                  style={{
                    color:
                      diagnose.openclawJson.detectedAt === "mcp.servers"
                        ? "#34d399"
                        : diagnose.openclawJson.detectedAt === "none"
                        ? "#fca5a5"
                        : "#facc15",
                  }}
                >
                  {diagnose.openclawJson.detectedAt}
                </strong>
              </div>
              <div>
                ACPX bridge:{" "}
                <strong
                  style={{
                    color:
                      diagnose.openclawJson.acpxBridgeEnabled === true
                        ? "#34d399"
                        : diagnose.openclawJson.acpxBridgeEnabled === false
                        ? "#fca5a5"
                        : "#facc15",
                  }}
                >
                  {diagnose.openclawJson.acpxBridgeEnabled === true
                    ? "ativo"
                    : diagnose.openclawJson.acpxBridgeEnabled === false
                    ? "desativado"
                    : "não configurado"}
                </strong>{" "}
                {diagnose.openclawJson.acpxBridgeEnabled !== true && (
                  <button
                    onClick={enableAcpxBridge}
                    disabled={phase === "enabling-bridge"}
                    className="ml-2 px-2 py-0.5 rounded text-xs"
                    style={{
                      backgroundColor: "rgba(139,92,246,0.18)",
                      color: "#c4b5fd",
                      border: "1px solid rgba(139,92,246,0.4)",
                    }}
                  >
                    {phase === "enabling-bridge" ? "ativando…" : "Habilitar ACPX bridge"}
                  </button>
                )}
              </div>
              {diagnose.openclawJson.atlasdeckMemoryEntry && (
                <div className="mt-1">
                  Entry: {diagnose.openclawJson.atlasdeckMemoryEntry.command}{" "}
                  {diagnose.openclawJson.atlasdeckMemoryEntry.args.join(" ")}
                  <br />
                  env keys: [
                  {diagnose.openclawJson.atlasdeckMemoryEntry.envKeys.join(", ")}]
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
              {diagnose.memoryMd.pathSource && (
                <div style={{ color: "var(--text-muted)" }}>
                  Path resolvido via:{" "}
                  <strong
                    style={{
                      color:
                        diagnose.memoryMd.pathSource === "openclaw.json"
                          ? "#34d399"
                          : "#facc15",
                    }}
                  >
                    {diagnose.memoryMd.pathSource}
                  </strong>
                  {diagnose.memoryMd.pathSource !== "openclaw.json" && (
                    <span> — pode estar drift do daemon</span>
                  )}
                </div>
              )}
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
