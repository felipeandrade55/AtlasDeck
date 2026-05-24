"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArchiveRestore,
  CheckCircle,
  RefreshCw,
  Upload,
  XCircle,
} from "lucide-react";

import {
  RESTORE_PHASE_LABELS,
  RestoreLiveStatus,
  RestorePhase,
  RestoreAudit,
} from "@/lib/restore-types";
import type { BackupOrigin, RestorePreview } from "@/lib/backup";

type UiState =
  | "idle"
  | "uploading"
  | "preview-ready"
  | "restoring"
  | "complete"
  | "error";

interface PreviewWithExtras extends RestorePreview {
  archiveSizeBytes?: number;
  uploadId?: string;
}

const PHASE_ORDER_WITH_SAFETY = [
  "validate",
  "safety-backup",
  "preview",
  "stop-app",
  "extract",
  "apply-data",
  "apply-env",
  "apply-home",
  "restart-openclaw",
  "start-app",
  "verify",
];

const PHASE_ORDER_NO_SAFETY = PHASE_ORDER_WITH_SAFETY.filter((p) => p !== "safety-backup");

const AUTO_RELOAD_SECONDS = 5;

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${sizes[i]}`;
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

function originLabel(o: BackupOrigin | null | undefined): string {
  if (!o) return "—";
  return `${o.user || "?"}@${o.hostname || "?"} (${o.platform})`;
}

export function RestorePanel() {
  const [uiState, setUiState] = useState<UiState>("idle");
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [uploadSize, setUploadSize] = useState(0);
  const [preview, setPreview] = useState<PreviewWithExtras | null>(null);
  const [createSafetyBackup, setCreateSafetyBackup] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [phases, setPhases] = useState<RestorePhase[]>([]);
  const [currentPhase, setCurrentPhase] = useState<string>("");
  const [logs, setLogs] = useState<{ line: string; timestamp: string }[]>([]);
  const [liveStatus, setLiveStatus] = useState<RestoreLiveStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [rolledBack, setRolledBack] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [audit, setAudit] = useState<RestoreAudit | null>(null);
  const [auditExpanded, setAuditExpanded] = useState(false);
  const [autoReloadIn, setAutoReloadIn] = useState<number | null>(null);

  const offsetsRef = useRef({ logOffset: 0, phaseOffset: 0 });
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const logsEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  // ─── Reset full state ────────────────────────────────────────────────────
  const resetAll = useCallback(() => {
    setUiState("idle");
    setUploadPercent(0);
    setUploadId(null);
    setUploadSize(0);
    setPreview(null);
    setAcknowledged(false);
    setPhases([]);
    setCurrentPhase("");
    setLogs([]);
    setLiveStatus(null);
    setErrorMsg("");
    setRolledBack(false);
    setDurationMs(0);
    setAudit(null);
    setAuditExpanded(false);
    setAutoReloadIn(null);
    offsetsRef.current = { logOffset: 0, phaseOffset: 0 };
  }, []);

  // ─── SSE attach ──────────────────────────────────────────────────────────
  const initPhases = useCallback((withSafety: boolean) => {
    const order = withSafety ? PHASE_ORDER_WITH_SAFETY : PHASE_ORDER_NO_SAFETY;
    setPhases(order.map((name) => ({ name, status: "pending" })));
  }, []);

  const applyPhaseEvent = useCallback(
    (evt: { phase: string; status: RestorePhase["status"]; durationSec?: number; error?: string; ts?: string }) => {
      setPhases((prev) => {
        const idx = prev.findIndex((p) => p.name === evt.phase);
        if (idx < 0) {
          return [
            ...prev,
            {
              name: evt.phase,
              status: evt.status,
              durationSec: evt.durationSec,
              error: evt.error,
              startedAt: evt.status === "running" ? evt.ts : undefined,
            },
          ];
        }
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          status: evt.status,
          durationSec: evt.durationSec ?? next[idx].durationSec,
          error: evt.error ?? next[idx].error,
          startedAt: evt.status === "running" ? evt.ts : next[idx].startedAt,
        };
        return next;
      });
      if (evt.status === "running") setCurrentPhase(evt.phase);
      if (evt.phase === "rollback" && evt.status === "ok") setRolledBack(true);
    },
    []
  );

  const connectStream = useCallback(() => {
    if (eventSourceRef.current) {
      try { eventSourceRef.current.close(); } catch {}
      eventSourceRef.current = null;
    }
    const params = new URLSearchParams({
      logOffset: String(offsetsRef.current.logOffset),
      phaseOffset: String(offsetsRef.current.phaseOffset),
    });
    const es = new EventSource(`/api/backup/restore/stream?${params.toString()}`);
    eventSourceRef.current = es;
    setReconnecting(false);

    es.addEventListener("snapshot", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        liveStatus: RestoreLiveStatus | null;
        logOffset: number;
        phaseOffset: number;
      };
      if (data.liveStatus) {
        setLiveStatus(data.liveStatus);
        setCurrentPhase(data.liveStatus.currentPhase);
        setPhases(data.liveStatus.phases);
      }
      offsetsRef.current = { logOffset: data.logOffset, phaseOffset: data.phaseOffset };
    });

    es.addEventListener("log", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { line: string; timestamp: string };
      setLogs((prev) => [...prev, data]);
    });

    es.addEventListener("phase", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      applyPhaseEvent(data);
    });

    es.addEventListener("offset", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { logOffset: number; phaseOffset: number };
      offsetsRef.current = data;
    });

    es.addEventListener("complete", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        success: boolean;
        error?: string;
        durationMs?: number;
        rolledBack?: boolean;
      };
      setUiState(data.success ? "complete" : "error");
      if (data.durationMs) setDurationMs(data.durationMs);
      if (!data.success && data.error) setErrorMsg(data.error);
      if (data.rolledBack) setRolledBack(true);
      try { es.close(); } catch {}
      eventSourceRef.current = null;
    });

    es.addEventListener("stream-error", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { message?: string };
      setUiState("error");
      setErrorMsg(data.message || "Erro no stream de restore");
      try { es.close(); } catch {}
      eventSourceRef.current = null;
    });

    es.addEventListener("error", () => {
      // EventSource erro = provavelmente pm2 restart (durante stop-app/start-app).
      // Tenta reconectar via /status.
      setReconnecting(true);
      try { es.close(); } catch {}
      eventSourceRef.current = null;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        void (async () => {
          try {
            const res = await fetch("/api/backup/restore/status");
            const data = await res.json();
            if (data.active) connectStream();
            else {
              // Restore terminou enquanto desconectado — busca estado final
              const finalRes = await fetch("/api/backup/restore/status");
              const finalData = await finalRes.json();
              if (finalData.status) {
                const s = finalData.status as RestoreLiveStatus;
                setLiveStatus(s);
                setPhases(s.phases);
                if (s.status === "complete") setUiState("complete");
                else if (s.status === "error") {
                  setUiState("error");
                  setErrorMsg(s.error || "Restore falhou");
                  if (s.rolledBack) setRolledBack(true);
                }
              }
              setReconnecting(false);
            }
          } catch {
            // Servidor ainda voltando — tenta novamente
            reconnectTimerRef.current = setTimeout(connectStream, 3000);
          }
        })();
      }, 2000);
    });
  }, [applyPhaseEvent]);

  // ─── Mount: tenta reanexar a um restore em andamento ─────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/backup/restore/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.active && data.status?.status === "running") {
          const s = data.status as RestoreLiveStatus;
          setLiveStatus(s);
          setPhases(s.phases);
          setCurrentPhase(s.currentPhase);
          setUiState("restoring");
          offsetsRef.current = { logOffset: 0, phaseOffset: 0 };
          connectStream();
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
      if (eventSourceRef.current) { try { eventSourceRef.current.close(); } catch {} }
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [connectStream]);

  // ─── Auto-scroll log ─────────────────────────────────────────────────────
  useEffect(() => {
    const container = logsEndRef.current?.closest<HTMLElement>(".overflow-y-auto");
    if (container) container.scrollTop = container.scrollHeight;
  }, [logs]);

  // ─── Fetch da auditoria quando termina (sucesso OU erro) ─────────────────
  useEffect(() => {
    if (uiState !== "complete" && uiState !== "error") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/backup/restore/audit", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as RestoreAudit;
        if (!cancelled) {
          setAudit(data);
          // Em caso de falha, expande direto pra mostrar o diagnóstico
          if (uiState === "error") setAuditExpanded(true);
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [uiState]);

  // ─── Countdown de auto-reload pós-sucesso ────────────────────────────────
  // Em modo PM2: a aplicação já reiniciou; recarregar a UI puxa dados frescos.
  // Em modo dev-local: a app continua rodando, mas o reload garante que a UI
  // pegue o estado atualizado de disco (notificações, atividades, configs).
  useEffect(() => {
    if (uiState !== "complete") {
      setAutoReloadIn(null);
      return;
    }
    setAutoReloadIn(AUTO_RELOAD_SECONDS);
    const interval = setInterval(() => {
      setAutoReloadIn((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearInterval(interval);
          window.location.reload();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [uiState]);

  const cancelAutoReload = useCallback(() => {
    setAutoReloadIn(null);
  }, []);

  const fetchPreview = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/backup/restore/preview?uploadId=${id}`);
      const data = await res.json();
      if (!res.ok) {
        setUiState("error");
        setErrorMsg(data.error || "Falha ao gerar preview do backup");
        return;
      }
      setPreview(data as PreviewWithExtras);
      setUiState("preview-ready");
    } catch (err) {
      setUiState("error");
      setErrorMsg(err instanceof Error ? err.message : "Falha ao buscar preview");
    }
  }, []);

  // ─── Upload com progresso (XHR para ter onprogress) ──────────────────────
  const uploadFile = useCallback(
    (file: File) => {
      resetAll();
      setUiState("uploading");
      setUploadPercent(0);

      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      xhr.open("POST", "/api/backup/upload");
      xhr.setRequestHeader("Content-Type", "application/gzip");

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setUploadPercent(Math.round((e.loaded / e.total) * 100));
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText) as { uploadId: string; sizeBytes: number };
            setUploadId(data.uploadId);
            setUploadSize(data.sizeBytes);
            void fetchPreview(data.uploadId);
          } catch (err) {
            setUiState("error");
            setErrorMsg("Resposta inválida do servidor após upload: " + (err as Error).message);
          }
        } else {
          let msg = `Upload falhou (HTTP ${xhr.status})`;
          try {
            const parsed = JSON.parse(xhr.responseText);
            if (parsed.error) msg = parsed.error;
          } catch {}
          setUiState("error");
          setErrorMsg(msg);
        }
      };

      xhr.onerror = () => {
        setUiState("error");
        setErrorMsg("Erro de rede durante upload");
      };

      xhr.send(file);
    },
    [resetAll, fetchPreview]
  );

  // ─── Iniciar restore ─────────────────────────────────────────────────────
  const startRestore = useCallback(async () => {
    if (!uploadId || !acknowledged || !preview) return;
    if (preview.platformMismatch) return;

    if (!window.confirm(
      "Tem certeza? A aplicação vai reiniciar e os dados atuais serão substituídos. " +
      (createSafetyBackup ? "Um snapshot pré-restore será criado automaticamente." : "Sem snapshot de segurança — esta operação NÃO terá rollback automático.")
    )) {
      return;
    }

    setLogs([]);
    setErrorMsg("");
    setRolledBack(false);
    initPhases(createSafetyBackup);
    offsetsRef.current = { logOffset: 0, phaseOffset: 0 };
    setUiState("restoring");

    try {
      const res = await fetch("/api/backup/restore/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploadId,
          createSafetyBackup,
          confirm: "RESTAURAR",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao iniciar restore");
      connectStream();
    } catch (err) {
      setUiState("error");
      setErrorMsg(err instanceof Error ? err.message : "Erro ao iniciar restore");
    }
  }, [acknowledged, connectStream, createSafetyBackup, initPhases, preview, uploadId]);

  // ─── Cancelar ────────────────────────────────────────────────────────────
  const cancelRestore = useCallback(async () => {
    if (!window.confirm("Cancelar o restore? Só é seguro até a fase 'extract' — depois disso, deixe terminar.")) return;
    try {
      const res = await fetch("/api/backup/restore/cancel", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Falha ao cancelar");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Falha ao cancelar");
    }
  }, []);

  // ─── Drag & drop ─────────────────────────────────────────────────────────
  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) uploadFile(file);
    },
    [uploadFile]
  );

  const renderPhaseIcon = (status: RestorePhase["status"]) => {
    switch (status) {
      case "ok":
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case "fail":
        return <XCircle className="w-4 h-4 text-red-500" />;
      case "running":
        return <RefreshCw className="w-4 h-4 text-blue-400 animate-spin" />;
      case "skip":
        return <span className="text-gray-400 text-xs">pulado</span>;
      default:
        return <div className="w-3 h-3 rounded-full border-2 border-gray-500" />;
    }
  };

  return (
    <div
      className="card p-6"
      style={{
        backgroundColor: "var(--card)",
        border: "1px solid var(--border)",
        borderRadius: "12px",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div
            className="p-2 rounded-lg"
            style={{ backgroundColor: "var(--surface-elevated)" }}
          >
            <ArchiveRestore className="w-6 h-6" style={{ color: "var(--accent)" }} />
          </div>
          <div>
            <h2
              className="text-xl font-bold"
              style={{ fontFamily: "var(--font-heading)", color: "var(--text-primary)" }}
            >
              Restaurar Backup
            </h2>
            <p
              className="text-sm"
              style={{ fontFamily: "var(--font-body)", color: "var(--text-secondary)" }}
            >
              Upload de .tar.gz gerado anteriormente · restauração automatizada com snapshot de segurança
            </p>
          </div>
        </div>
        {uiState !== "idle" && uiState !== "restoring" && (
          <button
            onClick={resetAll}
            className="px-3 py-1 rounded text-xs"
            style={{
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              color: "var(--text-secondary)",
            }}
          >
            Recomeçar
          </button>
        )}
      </div>

      {/* IDLE — Drop zone */}
      {uiState === "idle" && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className="rounded-xl p-10 text-center cursor-pointer transition-colors"
          style={{
            border: `2px dashed ${dragOver ? "var(--accent)" : "var(--border)"}`,
            backgroundColor: dragOver ? "rgba(99, 102, 241, 0.05)" : "var(--surface)",
          }}
        >
          <Upload className="w-10 h-10 mx-auto mb-3" style={{ color: "var(--text-muted)" }} />
          <p className="text-base mb-1" style={{ color: "var(--text-primary)" }}>
            Arraste o arquivo .tar.gz aqui
          </p>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            ou clique para selecionar do disco
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".tar.gz,.tgz,application/gzip,application/x-gzip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadFile(file);
              e.target.value = "";
            }}
          />
        </div>
      )}

      {/* UPLOADING */}
      {uiState === "uploading" && (
        <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className="flex items-center gap-3 mb-3">
            <Upload className="w-5 h-5 animate-pulse" style={{ color: "var(--accent)" }} />
            <span style={{ color: "var(--text-primary)" }}>Enviando arquivo… {uploadPercent}%</span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: "var(--border)" }}>
            <div
              className="h-full transition-all"
              style={{ width: `${uploadPercent}%`, backgroundColor: "var(--accent)" }}
            />
          </div>
        </div>
      )}

      {/* PREVIEW-READY */}
      {uiState === "preview-ready" && preview && (
        <div className="space-y-4">
          {/* Origin card */}
          <div className="rounded-xl p-5" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>
            <h3 className="text-sm font-bold uppercase tracking-wider mb-3" style={{ color: "var(--text-muted)" }}>
              Origem do backup
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <Field label="Host" value={originLabel(preview.origin)} />
              <Field label="Plataforma" value={preview.origin?.platform || "—"} />
              <Field label="Home original" value={preview.origin?.homeDir || "—"} />
              <Field label="Tamanho" value={formatBytes(preview.archiveSizeBytes ?? uploadSize)} />
              <Field label="Entradas no tar" value={String(preview.entries)} />
              <Field label="Node original" value={preview.origin?.nodeVersion || "—"} />
            </div>

            {/* Warnings */}
            {preview.platformMismatch && (
              <div className="mt-4 p-3 rounded-lg flex items-start gap-2" style={{ backgroundColor: "rgba(239, 68, 68, 0.1)" }}>
                <XCircle className="w-5 h-5 mt-0.5" style={{ color: "var(--negative, #ef4444)" }} />
                <div className="text-sm">
                  <strong>Restore cross-platform não suportado.</strong> Backup foi gerado em{" "}
                  <code>{preview.origin?.platform}</code>, máquina atual é <code>{preview.currentPlatform}</code>.
                </div>
              </div>
            )}
            {!preview.platformMismatch && preview.needsRemap && (
              <div className="mt-4 p-3 rounded-lg flex items-start gap-2" style={{ backgroundColor: "rgba(234, 179, 8, 0.1)" }}>
                <AlertTriangle className="w-5 h-5 mt-0.5" style={{ color: "var(--warning, #eab308)" }} />
                <div className="text-sm">
                  <strong>Remap de paths necessário.</strong> Home directory diferente — arquivos serão movidos de{" "}
                  <code>{preview.origin?.homeDir}</code> para <code>{preview.currentHome}</code>.
                </div>
              </div>
            )}
          </div>

          {/* What will be overwritten */}
          <div className="rounded-xl p-4" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>
            <h3 className="text-sm font-bold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>
              O que será sobrescrito
            </h3>
            <ul className="text-sm space-y-1" style={{ color: "var(--text-secondary)" }}>
              <li>• <code>./data/</code> — bancos SQLite (activities, chats, memories, metrics, usage-tracking) + JSONs de config</li>
              <li>• <code>.env</code> na raiz do projeto</li>
              <li>• <code>~/.openclaw/</code> — config, skills, plugins, agentes, workspaces</li>
              <li>• <code>~/.claude/</code> — skills, plugins, settings.json, projects</li>
            </ul>
          </div>

          {/* Safety backup option */}
          <div className="rounded-xl p-4" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={createSafetyBackup}
                onChange={(e) => setCreateSafetyBackup(e.target.checked)}
                className="mt-1"
              />
              <div>
                <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                  Criar snapshot pré-restore (rollback automático)
                </div>
                <div className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>
                  Adiciona ~30-60s ao processo. Se algo falhar, o snapshot é re-aplicado automaticamente.
                  Recomendado deixar marcado.
                </div>
              </div>
            </label>
          </div>

          {/* Confirmation gate */}
          {!preview.platformMismatch && (
            <div className="rounded-xl p-4" style={{ backgroundColor: "rgba(239, 68, 68, 0.05)", border: "1px solid rgba(239, 68, 68, 0.3)" }}>
              <label className="flex items-start gap-3 cursor-pointer mb-4">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-1"
                />
                <div className="text-sm" style={{ color: "var(--text-primary)" }}>
                  Entendi que os dados atuais serão <strong>substituídos integralmente</strong> pelo
                  conteúdo do backup, incluindo bancos, .env e diretórios em <code>~/</code>.
                </div>
              </label>
              <button
                onClick={startRestore}
                disabled={!acknowledged}
                className="w-full py-3 rounded-lg font-semibold transition-opacity"
                style={{
                  backgroundColor: acknowledged ? "#dc2626" : "rgba(220, 38, 38, 0.3)",
                  color: "#fff",
                  cursor: acknowledged ? "pointer" : "not-allowed",
                }}
              >
                Restaurar agora
              </button>
            </div>
          )}
        </div>
      )}

      {/* RESTORING */}
      {uiState === "restoring" && (
        <div className="space-y-4">
          {reconnecting && (
            <div className="p-3 rounded-lg flex items-center gap-2" style={{ backgroundColor: "rgba(234, 179, 8, 0.1)" }}>
              <RefreshCw className="w-4 h-4 animate-spin" style={{ color: "var(--warning, #eab308)" }} />
              <span className="text-sm" style={{ color: "var(--text-primary)" }}>
                Reconectando… {liveStatus?.pm2Managed ? "(aplicação reiniciando — isso é esperado)" : ""}
              </span>
            </div>
          )}

          {/* Pipeline */}
          <div className="rounded-xl p-4" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>
            <h3 className="text-sm font-bold uppercase tracking-wider mb-3" style={{ color: "var(--text-muted)" }}>
              Pipeline ({phases.filter((p) => p.status === "ok").length}/{phases.length})
            </h3>
            <div className="space-y-2">
              {phases.map((p) => (
                <div key={p.name} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    {renderPhaseIcon(p.status)}
                    <span style={{ color: p.name === currentPhase ? "var(--text-primary)" : "var(--text-secondary)" }}>
                      {RESTORE_PHASE_LABELS[p.name] || p.name}
                    </span>
                  </div>
                  {p.durationSec !== undefined && p.status !== "running" && (
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                      {p.durationSec}s
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Terminal */}
          <div
            className="rounded-xl overflow-hidden"
            style={{ backgroundColor: "#0f1117", border: "1px solid var(--border)" }}
          >
            <div className="px-4 py-2 text-xs" style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)" }}>
              Terminal · {logs.length} linha(s)
            </div>
            <div className="p-3 max-h-72 overflow-y-auto font-mono text-xs" style={{ color: "#d1d5db" }}>
              {logs.length === 0 ? (
                <div style={{ color: "#6b7280" }}>Aguardando saída do worker…</div>
              ) : (
                logs.map((l, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all">{l.line}</div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>

          {/* Cancel button (apenas antes de apply-data) */}
          <div className="flex justify-end">
            <button
              onClick={cancelRestore}
              className="px-4 py-2 rounded-lg text-sm"
              style={{
                backgroundColor: "var(--surface)",
                border: "1px solid var(--border)",
                color: "var(--text-secondary)",
              }}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* COMPLETE */}
      {uiState === "complete" && (
        <div className="space-y-4">
          {/* Hero success */}
          <div
            className="p-6 rounded-xl"
            style={{ backgroundColor: "rgba(34, 197, 94, 0.1)", border: "1px solid rgba(34, 197, 94, 0.3)" }}
          >
            <div className="flex items-start gap-4">
              <CheckCircle className="w-8 h-8 mt-1 shrink-0" style={{ color: "var(--positive, #22c55e)" }} />
              <div className="flex-1 min-w-0">
                <h3 className="text-xl font-bold mb-1" style={{ color: "var(--positive, #22c55e)" }}>
                  Restauração concluída com sucesso
                </h3>
                <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                  {audit?.headline || (durationMs > 0 ? `Concluído em ${formatDuration(durationMs)}.` : "Backup aplicado.")}
                </p>
                {liveStatus && liveStatus.pm2Managed === false && (
                  <div
                    className="mt-3 p-3 rounded-lg flex items-start gap-2"
                    style={{ backgroundColor: "rgba(234, 179, 8, 0.15)" }}
                  >
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "var(--warning, #eab308)" }} />
                    <div className="text-sm" style={{ color: "var(--text-primary)" }}>
                      <strong>Modo dev local:</strong> sem PM2 para reiniciar a app automaticamente. O reload da página
                      garante que a UI puxe os dados restaurados. Caso configs do <code>.env</code> não tenham efeito,
                      reinicie o servidor (<code>Ctrl+C</code> + <code>npm run dev</code>).
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Auto-reload countdown */}
            {autoReloadIn !== null && autoReloadIn > 0 && (
              <div
                className="mt-4 p-3 rounded-lg flex items-center justify-between gap-3"
                style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}
              >
                <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-primary)" }}>
                  <RefreshCw className="w-4 h-4 animate-spin" style={{ color: "var(--accent)" }} />
                  Recarregando o dashboard em <strong>{autoReloadIn}s</strong>…
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => window.location.reload()}
                    className="px-3 py-1 rounded text-xs font-medium"
                    style={{ backgroundColor: "var(--accent)", color: "#fff" }}
                  >
                    Recarregar agora
                  </button>
                  <button
                    onClick={cancelAutoReload}
                    className="px-3 py-1 rounded text-xs"
                    style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
                  >
                    Cancelar (ler relatório)
                  </button>
                </div>
              </div>
            )}

            {autoReloadIn === null && (
              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => window.location.reload()}
                  className="px-4 py-2 rounded-lg text-sm font-medium"
                  style={{ backgroundColor: "var(--accent)", color: "#fff" }}
                >
                  Recarregar dashboard
                </button>
                <button
                  onClick={resetAll}
                  className="px-4 py-2 rounded-lg text-sm"
                  style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
                >
                  Fazer outro restore
                </button>
              </div>
            )}
          </div>

          {/* Audit / Conferência */}
          {audit && (
            <AuditCard
              audit={audit}
              expanded={auditExpanded}
              onToggle={() => setAuditExpanded((v) => !v)}
            />
          )}
        </div>
      )}

      {/* ERROR */}
      {uiState === "error" && (
        <div className="space-y-4">
          {/* Hero error */}
          <div
            className="p-6 rounded-xl"
            style={{
              backgroundColor: rolledBack ? "rgba(234, 179, 8, 0.1)" : "rgba(239, 68, 68, 0.1)",
              border: `1px solid ${rolledBack ? "rgba(234, 179, 8, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
            }}
          >
            <div className="flex items-start gap-4">
              {rolledBack ? (
                <AlertTriangle className="w-8 h-8 mt-1 shrink-0" style={{ color: "var(--warning, #eab308)" }} />
              ) : (
                <XCircle className="w-8 h-8 mt-1 shrink-0" style={{ color: "var(--negative, #ef4444)" }} />
              )}
              <div className="flex-1 min-w-0">
                <h3
                  className="text-xl font-bold mb-1"
                  style={{ color: rolledBack ? "var(--warning, #eab308)" : "var(--negative, #ef4444)" }}
                >
                  {audit?.errorTitle || (rolledBack ? "Restauração revertida automaticamente" : "Falha na restauração")}
                </h3>
                <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                  {audit?.errorExplanation || errorMsg || "Erro desconhecido durante o restore."}
                </p>

                {/* IMPACTO — primeira coisa que o usuário precisa saber */}
                {audit?.errorImpact && (
                  <div
                    className="mt-3 p-3 rounded-lg"
                    style={{
                      backgroundColor: rolledBack
                        ? "rgba(34, 197, 94, 0.1)"
                        : "var(--surface)",
                      border: `1px solid ${rolledBack ? "rgba(34, 197, 94, 0.3)" : "var(--border)"}`,
                    }}
                  >
                    <div className="text-xs font-bold uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>
                      Estado dos seus dados
                    </div>
                    <div className="text-sm" style={{ color: "var(--text-primary)" }}>
                      {audit.errorImpact}
                    </div>
                  </div>
                )}

                {/* AÇÕES SUGERIDAS */}
                {audit?.suggestedActions && audit.suggestedActions.length > 0 && (
                  <div className="mt-3">
                    <div className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>
                      O que fazer agora
                    </div>
                    <ol className="text-sm space-y-1.5" style={{ color: "var(--text-primary)" }}>
                      {audit.suggestedActions.map((action, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="font-mono shrink-0" style={{ color: "var(--text-muted)" }}>
                            {i + 1}.
                          </span>
                          <span>{action}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                <div className="flex gap-2 mt-4 flex-wrap">
                  <button
                    onClick={resetAll}
                    className="px-4 py-2 rounded-lg text-sm font-medium"
                    style={{ backgroundColor: "var(--accent)", color: "#fff" }}
                  >
                    Tentar novamente
                  </button>
                  {liveStatus?.safetyBackupPath && (
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(liveStatus.safetyBackupPath!);
                      }}
                      className="px-4 py-2 rounded-lg text-sm"
                      style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
                      title="Copiar path do snapshot"
                    >
                      Copiar path do snapshot
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Audit / Conferência */}
          {audit && (
            <AuditCard
              audit={audit}
              expanded={auditExpanded}
              onToggle={() => setAuditExpanded((v) => !v)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider mb-0.5" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
      <div className="font-mono text-sm break-all" style={{ color: "var(--text-primary)" }}>
        {value}
      </div>
    </div>
  );
}

function InventoryRow({
  label,
  ok,
  note,
}: {
  label: string;
  ok: boolean;
  note?: string;
}) {
  return (
    <div className="flex items-center justify-between text-sm py-1">
      <div className="flex items-center gap-2">
        {ok ? (
          <CheckCircle className="w-4 h-4 shrink-0" style={{ color: "var(--positive, #22c55e)" }} />
        ) : (
          <XCircle className="w-4 h-4 shrink-0" style={{ color: "var(--negative, #ef4444)" }} />
        )}
        <span style={{ color: "var(--text-primary)" }}>{label}</span>
      </div>
      {note && (
        <span className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
          {note}
        </span>
      )}
    </div>
  );
}

function formatBytesShort(bytes?: number): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function AuditCard({
  audit,
  expanded,
  onToggle,
}: {
  audit: RestoreAudit;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isFailure = audit.overallStatus !== "success";

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}
    >
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 text-left"
        style={{ borderBottom: expanded ? "1px solid var(--border)" : "none" }}
      >
        <div>
          <h4 className="text-sm font-bold uppercase tracking-wider" style={{ color: "var(--text-primary)" }}>
            Conferência detalhada
          </h4>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>
            {audit.headline}
          </p>
        </div>
        <span className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
          {expanded ? "▼ ocultar" : "▶ expandir"}
        </span>
      </button>

      {expanded && (
        <div className="p-4 space-y-4">
          {/* Inventário */}
          <div>
            <h5
              className="text-xs font-bold uppercase tracking-wider mb-2"
              style={{ color: "var(--text-muted)" }}
            >
              Inventário do que foi aplicado
            </h5>
            <div
              className="rounded-lg p-3"
              style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
            >
              <InventoryRow
                label="Snapshot pré-restore criado"
                ok={audit.inventory.safetyBackupCreated}
                note={audit.safetyBackupPath ? "✓" : "não solicitado"}
              />
              <InventoryRow label="Aplicação parada" ok={audit.inventory.appStopped} />
              <InventoryRow label="Arquivo extraído" ok={audit.inventory.archiveExtracted} />
              <InventoryRow
                label="Bancos SQLite + JSONs aplicados"
                ok={audit.inventory.dataApplied}
                note={(() => {
                  const p = audit.phases.find((x) => x.name === "apply-data");
                  if (!p || p.filesRestored === undefined) return undefined;
                  return `${p.filesRestored} arquivos · ${formatBytesShort(p.bytesRestored)}`;
                })()}
              />
              <InventoryRow
                label=".env aplicado"
                ok={audit.inventory.envApplied}
                note={(() => {
                  const p = audit.phases.find((x) => x.name === "apply-env");
                  return p?.bytesRestored ? formatBytesShort(p.bytesRestored) : undefined;
                })()}
              />
              <InventoryRow
                label="~/.openclaw + ~/.claude aplicados"
                ok={audit.inventory.homeApplied}
                note={(() => {
                  const p = audit.phases.find((x) => x.name === "apply-home");
                  if (!p || p.filesRestored === undefined) return undefined;
                  return `${p.filesRestored} arquivos · ${formatBytesShort(p.bytesRestored)}`;
                })()}
              />
              <InventoryRow
                label="OpenClaw Gateway reiniciado"
                ok={audit.inventory.openclawRestarted}
                note={
                  audit.phases.find((x) => x.name === "restart-openclaw")?.status === "skip"
                    ? "não gerenciado"
                    : undefined
                }
              />
              <InventoryRow label="Aplicação reiniciada" ok={audit.inventory.appStarted} />
              <InventoryRow label="Health check passou" ok={audit.inventory.healthVerified} />
            </div>
          </div>

          {/* Pipeline de fases */}
          <div>
            <h5
              className="text-xs font-bold uppercase tracking-wider mb-2"
              style={{ color: "var(--text-muted)" }}
            >
              Linha do tempo das fases
            </h5>
            <div
              className="rounded-lg p-3 text-xs"
              style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
            >
              {audit.phases.map((p) => (
                <div key={p.name} className="flex items-center justify-between py-1">
                  <div className="flex items-center gap-2">
                    {p.status === "ok" && <CheckCircle className="w-3 h-3" style={{ color: "var(--positive, #22c55e)" }} />}
                    {p.status === "fail" && <XCircle className="w-3 h-3" style={{ color: "var(--negative, #ef4444)" }} />}
                    {p.status === "skip" && (
                      <span style={{ color: "var(--text-muted)" }} className="font-mono">–</span>
                    )}
                    {(p.status === "pending" || p.status === "running") && (
                      <div className="w-3 h-3 rounded-full border-2" style={{ borderColor: "var(--text-muted)" }} />
                    )}
                    <span style={{ color: "var(--text-primary)" }}>{p.label}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    {p.error && (
                      <span className="text-xs italic max-w-xs truncate" style={{ color: "var(--negative, #ef4444)" }} title={p.error}>
                        {p.error}
                      </span>
                    )}
                    <span style={{ color: "var(--text-muted)" }} className="font-mono">
                      {p.durationSec !== undefined ? `${p.durationSec}s` : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Metadata */}
          <div>
            <h5
              className="text-xs font-bold uppercase tracking-wider mb-2"
              style={{ color: "var(--text-muted)" }}
            >
              Metadados
            </h5>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <Field
                label="Origem"
                value={
                  audit.origin
                    ? `${audit.origin.user || "?"}@${audit.origin.hostname || "?"} (${audit.origin.platform})`
                    : "—"
                }
              />
              <Field
                label="Duração total"
                value={audit.durationMs ? `${Math.round(audit.durationMs / 1000)}s` : "—"}
              />
              <Field
                label="Modo"
                value={audit.pm2Managed ? "PM2 (produção)" : "Dev local (sem PM2)"}
              />
              <Field
                label="Snapshot pré-restore"
                value={audit.safetyBackupPath || "não criado"}
              />
              {isFailure && audit.errorCategory && (
                <Field label="Categoria do erro" value={audit.errorCategory} />
              )}
              {audit.rolledBack && <Field label="Rollback automático" value="✓ aplicado" />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
