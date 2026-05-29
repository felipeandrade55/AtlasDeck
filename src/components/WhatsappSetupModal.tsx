"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  X,
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Eye,
  EyeOff,
  Send,
  Trash2,
  Save,
  MessageSquare,
  Smartphone,
  Inbox,
  Copy,
  Check,
  Plus,
  FileText,
  Power,
  Wrench,
} from "lucide-react";
import { RestartStatusBanner } from "./RestartStatusBanner";
import {
  restartGatewayClient,
  getAutoRestartPref,
  setAutoRestartPref,
  type ClientRestartResult,
} from "@/lib/restart-gateway-client";

interface WhatsappAccount {
  id: string;
  hasToken: boolean;
  tokenMasked: string;
  token: string | null;
  phoneNumber: string | null;
  chatId: string | null;
  dmPolicy: string | null;
  sessionStatus: "connected" | "disconnected" | "authenticating";
  diagnostics: null | {
    connected: boolean;
    error?: string;
  };
}

interface WhatsappConfigResponse {
  config: {
    path: string;
    isFallback: boolean;
    enabled: boolean;
    dmPolicy: string;
  };
  accounts: WhatsappAccount[];
  recentActivity: Array<{ timestamp: string; status: string; description: string }>;
  summary: { healthy: boolean; issues: string[]; issueCount: number };
  timestamp: string;
  error?: string;
}

interface AccountDraft {
  id: string;          // immutable for existing, editable for new
  isNew: boolean;
  hasExistingToken: boolean;
  token: string;       // "" means clear
  tokenTouched: boolean;
  phoneNumber: string;
  chatId: string;
  dmPolicy: string;
  showToken: boolean;
  toDelete: boolean;
}

const DM_POLICIES = [
  { value: "pairing", label: "pairing (recomendado — exige pareamento)" },
  { value: "open", label: "open (qualquer um pode iniciar DM)" },
  { value: "off", label: "off (DMs desabilitadas)" },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function WhatsappSetupModal({ open, onClose }: Props) {
  const [data, setData] = useState<WhatsappConfigResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [enabled, setEnabled] = useState<boolean>(false);
  const [globalDmPolicy, setGlobalDmPolicy] = useState<string>("pairing");
  const [drafts, setDrafts] = useState<AccountDraft[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<Record<string, { kind: "ok" | "err"; text: string }>>({});

  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [autoRestart, setAutoRestart] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<ClientRestartResult | null>(null);

  const [pairingAccountId, setPairingAccountId] = useState<string | null>(null);
  const [pairingMessage, setPairingMessage] = useState<string>("");
  const [pairingQrDataUrl, setPairingQrDataUrl] = useState<string | null>(null);
  const [pairingConnected, setPairingConnected] = useState<boolean>(false);
  const [pairingError, setPairingError] = useState<{ error: string; hint?: string } | null>(null);
  const [pairingLoading, setPairingLoading] = useState<boolean>(false);

  const [repairing, setRepairing] = useState(false);
  const [repairResult, setRepairResult] = useState<{
    ok: boolean;
    summary: string;
    detail: string;
  } | null>(null);

  useEffect(() => {
    setAutoRestart(getAutoRestartPref());
  }, []);
  const updateAutoRestart = (v: boolean) => {
    setAutoRestart(v);
    setAutoRestartPref(v);
  };

  const refresh = useCallback(async (opts: { reveal?: boolean } = {}) => {
    setLoading(true);
    setLoadError(null);
    try {
      const url = `/api/integrations/whatsapp?live=1${opts.reveal ? "&revealToken=1" : ""}`;
      const res = await fetch(url, { cache: "no-store" });
      const json: WhatsappConfigResponse = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
      setEnabled(json.config.enabled);
      setGlobalDmPolicy(json.config.dmPolicy || "pairing");
      setDrafts(
        json.accounts.map((a) => ({
          id: a.id,
          isNew: false,
          hasExistingToken: a.hasToken,
          token: a.token ?? "",
          tokenTouched: false,
          phoneNumber: a.phoneNumber ?? "",
          chatId: a.chatId ?? "",
          dmPolicy: a.dmPolicy || json.config.dmPolicy || "pairing",
          showToken: false,
          toDelete: false,
        })),
      );
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void refresh();
      setSaveMsg(null);
      setActionMsg({});
    }
  }, [open, refresh]);

  // Polling do QR via gateway HTTP tool — não há mais terminal/spawn pra rastrear.
  // O endpoint /qr-login com action=wait bloqueia até o QR mudar ou conectar.
  useEffect(() => {
    if (!pairingAccountId) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let isActive = true;

    async function poll() {
      try {
        const res = await fetch("/api/integrations/whatsapp/qr-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountId: pairingAccountId,
            action: "wait",
            currentQrDataUrl: pairingQrDataUrl ?? undefined,
          }),
        });
        const data = await res.json();
        if (!isActive) return;

        if (!res.ok) {
          setPairingError({ error: data.error || `HTTP ${res.status}`, hint: data.hint });
          return; // stop polling
        }

        if (data.qrDataUrl) setPairingQrDataUrl(data.qrDataUrl);
        if (data.message) setPairingMessage(data.message);

        if (data.connected) {
          setPairingConnected(true);
          setPairingMessage(data.message || "Conectado!");
          void refresh();
          return; // stop polling
        }

        timer = setTimeout(poll, 1200);
      } catch (err) {
        if (!isActive) return;
        setPairingError({ error: err instanceof Error ? err.message : String(err) });
      }
    }

    timer = setTimeout(poll, 600);

    return () => {
      isActive = false;
      if (timer) clearTimeout(timer);
    };
  }, [pairingAccountId, pairingQrDataUrl, refresh]);

  const startPairing = async (accountId: string) => {
    setPairingAccountId(accountId);
    setPairingMessage("Pedindo QR ao gateway…");
    setPairingQrDataUrl(null);
    setPairingConnected(false);
    setPairingError(null);
    setPairingLoading(true);
    try {
      const res = await fetch("/api/integrations/whatsapp/qr-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, action: "start", force: false }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPairingError({ error: data.error || `HTTP ${res.status}`, hint: data.hint });
        return;
      }
      if (data.qrDataUrl) setPairingQrDataUrl(data.qrDataUrl);
      if (data.message) setPairingMessage(data.message);
      if (data.connected) {
        setPairingConnected(true);
        void refresh();
      }
    } catch (e) {
      setPairingError({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setPairingLoading(false);
    }
  };

  const stopPairing = (accountId: string) => {
    // No spawn to kill — the gateway wait endpoint times out on its own.
    // Just clear UI state so the polling effect tears down.
    void accountId;
    setPairingAccountId(null);
    setPairingMessage("");
    setPairingQrDataUrl(null);
    setPairingConnected(false);
    setPairingError(null);
    void refresh();
  };

  const addAccount = () => {
    const baseId = "whatsapp-acc";
    let i = 1;
    const ids = new Set(drafts.map((d) => d.id));
    let candidate = drafts.length === 0 ? "main" : `${baseId}-${i}`;
    while (ids.has(candidate)) {
      i += 1;
      candidate = `${baseId}-${i}`;
    }
    setDrafts((d) => [
      ...d,
      {
        id: candidate,
        isNew: true,
        hasExistingToken: false,
        token: "",
        tokenTouched: true,
        phoneNumber: "",
        chatId: "",
        dmPolicy: globalDmPolicy,
        showToken: true,
        toDelete: false,
      },
    ]);
  };

  const updateDraft = (id: string, patch: Partial<AccountDraft>) => {
    setDrafts((d) => d.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  };

  const onSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const accounts: Record<string, { token?: string; phoneNumber?: string; chatId?: string; dmPolicy?: string }> = {};
      const deleteAccountIds: string[] = [];
      for (const d of drafts) {
        if (d.toDelete && !d.isNew) {
          deleteAccountIds.push(d.id);
          continue;
        }
        if (d.toDelete && d.isNew) continue;
        if (!d.id.trim()) {
          throw new Error("ID da conta não pode ser vazio");
        }
        const patch: { token?: string; phoneNumber?: string; chatId?: string; dmPolicy?: string } = {
          phoneNumber: d.phoneNumber,
          chatId: d.chatId,
          dmPolicy: d.dmPolicy,
        };
        if (d.tokenTouched) patch.token = d.token;
        if (d.isNew && !d.tokenTouched) patch.token = "";
        accounts[d.id] = patch;
      }

      const res = await fetch("/api/integrations/whatsapp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          dmPolicy: globalDmPolicy,
          accounts,
          deleteAccountIds,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setSaveMsg({ kind: "ok", text: "Configuração salva" });
      await refresh();
      if (autoRestart) {
        setRestarting(true);
        setRestartResult(null);
        const result = await restartGatewayClient();
        setRestartResult(result);
        setRestarting(false);
      }
    } catch (e) {
      setSaveMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async (accountId: string) => {
    const key = `test-${accountId}`;
    setActionBusy(key);
    setActionMsg((m) => ({ ...m, [accountId]: { kind: "ok", text: "enviando…" } }));
    try {
      const draft = drafts.find((d) => d.id === accountId);
      const draftToken = draft?.tokenTouched ? draft.token.trim() : "";
      const res = await fetch(`/api/integrations/whatsapp?action=test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          chatId: draft?.chatId || undefined,
          token: draftToken || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setActionMsg((m) => ({ ...m, [accountId]: { kind: "ok", text: `Mensagem enviada para ${json.sentTo}` } }));
    } catch (e) {
      setActionMsg((m) => ({
        ...m,
        [accountId]: { kind: "err", text: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      setActionBusy(null);
    }
  };

  const repairConfig = async () => {
    setRepairing(true);
    setRepairResult(null);
    try {
      const res = await fetch("/api/integrations/whatsapp/repair", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);

      const sweep = json.sweep || {};
      const validate = json.validate || {};
      const movedBits: string[] = [];
      if (sweep.changedWhatsapp) movedBits.push("WhatsApp limpo");
      if (sweep.changedTelegram) movedBits.push("Telegram limpo");
      if (sweep.changedGatewayToolsAllow) movedBits.push("whatsapp_login liberado no gateway");
      if (movedBits.length === 0) movedBits.push("nada a migrar");

      const detail = (validate.output || "").trim() || "(validator não respondeu)";
      const ok = validate.ok === true || (sweep.ran && validate.ok !== false);

      setRepairResult({
        ok,
        summary: ok
          ? `Reparo aplicado: ${movedBits.join(" · ")}. Schema OK.`
          : `Schema ainda rejeita após reparo: ${movedBits.join(" · ")}.`,
        detail,
      });

      await refresh();
      if (autoRestart && ok) {
        setRestarting(true);
        setRestartResult(null);
        const result = await restartGatewayClient();
        setRestartResult(result);
        setRestarting(false);
      }
    } catch (e) {
      setRepairResult({
        ok: false,
        summary: "Falha ao reparar config",
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRepairing(false);
    }
  };

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1200);
    } catch {}
  };

  const issues = data?.summary.issues || [];
  const recentActivity = data?.recentActivity || [];

  const accountsById = useMemo(() => {
    const map = new Map<string, WhatsappAccount>();
    for (const a of data?.accounts || []) map.set(a.id, a);
    return map;
  }, [data]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.65)" }}
      onClick={onClose}
    >
      <div
        className="rounded-xl w-full max-w-3xl max-h-[92vh] overflow-hidden flex flex-col"
        style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center gap-2">
            <MessageSquare className="w-5 h-5" style={{ color: "var(--accent)" }} />
            <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
              WhatsApp — configuração & diagnóstico
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void repairConfig()}
              disabled={repairing}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg disabled:opacity-50"
              style={{
                backgroundColor: "rgba(234,179,8,0.10)",
                color: "#fbbf24",
                border: "1px solid rgba(234,179,8,0.35)",
              }}
              title="Sanitiza channels.whatsapp.accounts em ~/.openclaw/openclaw.json e revalida o schema (use quando o pareamento via QR falha com 'must NOT have additional properties')"
            >
              {repairing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Wrench className="w-3.5 h-3.5" />
              )}
              Reparar config
            </button>
            <button
              onClick={() => refresh()}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg disabled:opacity-50"
              style={{ backgroundColor: "rgba(255,255,255,0.04)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
              title="Recarregar status"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              Atualizar
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg"
              style={{ color: "var(--text-secondary)" }}
              aria-label="Fechar"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-auto px-5 py-4 space-y-5">
          {loadError && (
            <div className="p-3 rounded-lg text-sm flex items-center gap-2"
                 style={{ backgroundColor: "rgba(239,68,68,0.08)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)" }}>
              <XCircle className="w-4 h-4 shrink-0" />
              {loadError}
            </div>
          )}

          {loading && !data && (
            <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-muted)" }}>
              <Loader2 className="w-4 h-4 animate-spin" />
              Carregando configuração e diagnósticos…
            </div>
          )}

          {repairResult && (
            <div
              className="rounded-lg p-3 text-sm"
              style={{
                backgroundColor: repairResult.ok
                  ? "rgba(16,185,129,0.08)"
                  : "rgba(234,179,8,0.08)",
                border: `1px solid ${repairResult.ok ? "rgba(16,185,129,0.35)" : "rgba(234,179,8,0.35)"}`,
                color: repairResult.ok ? "#6ee7b7" : "#fbbf24",
              }}
            >
              <div className="flex items-start gap-2">
                {repairResult.ok ? (
                  <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{repairResult.summary}</div>
                  {repairResult.detail && (
                    <pre className="text-[11px] mt-1 font-mono whitespace-pre-wrap" style={{ color: "var(--text-secondary)" }}>
                      {repairResult.detail}
                    </pre>
                  )}
                </div>
                <button
                  onClick={() => setRepairResult(null)}
                  className="text-[11px] px-1.5 py-0.5 rounded"
                  style={{ color: "var(--text-muted)" }}
                >
                  Fechar
                </button>
              </div>
            </div>
          )}

          {data && (
            <>
              {/* Summary / Issues */}
              <div
                className="rounded-lg p-3"
                style={{
                  backgroundColor: data.summary.healthy ? "rgba(16,185,129,0.06)" : "rgba(234,179,8,0.06)",
                  border: `1px solid ${data.summary.healthy ? "rgba(16,185,129,0.3)" : "rgba(234,179,8,0.3)"}`,
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  {data.summary.healthy ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-yellow-400" />
                  )}
                  <span className="font-medium text-sm" style={{ color: "var(--text-primary)" }}>
                    {data.summary.healthy ? "WhatsApp operacional" : `Encontrei ${issues.length} ponto${issues.length === 1 ? "" : "s"} para revisar`}
                  </span>
                </div>
                {issues.length > 0 && (
                  <ul className="text-xs mt-2 space-y-1 list-disc list-inside" style={{ color: "var(--text-secondary)" }}>
                    {issues.map((iss, i) => (
                      <li key={i}>{iss}</li>
                    ))}
                  </ul>
                )}
                <div className="text-[11px] mt-2 flex items-center gap-2" style={{ color: "var(--text-muted)" }}>
                  <FileText className="w-3 h-3" />
                  <span>Config: <code>{data.config.path}</code>{data.config.isFallback && " (fallback local)"}</span>
                </div>
              </div>

              {/* Global controls */}
              <div className="rounded-lg p-3 space-y-3" style={{ backgroundColor: "rgba(0,0,0,0.2)", border: "1px solid var(--border)" }}>
                <h3 className="text-xs uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                  Configurações globais do canal
                </h3>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: "var(--text-primary)" }}>
                    <Power className="w-3.5 h-3.5" style={{ color: enabled ? "#34d399" : "var(--text-muted)" }} />
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => setEnabled(e.target.checked)}
                    />
                    Canal habilitado (<code>channels.whatsapp.enabled</code>)
                  </label>
                  <div className="flex items-center gap-2 text-sm">
                    <span style={{ color: "var(--text-secondary)" }}>DM Policy global:</span>
                    <select
                      value={globalDmPolicy}
                      onChange={(e) => setGlobalDmPolicy(e.target.value)}
                      className="rounded px-2 py-1 text-xs"
                      style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                    >
                      {DM_POLICIES.map((p) => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Accounts */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                    Contas (WhatsApp Senders)
                  </h3>
                  <button
                    onClick={addAccount}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded"
                    style={{ backgroundColor: "rgba(139,92,246,0.1)", color: "#c4b5fd", border: "1px solid rgba(139,92,246,0.3)" }}
                  >
                    <Plus className="w-3 h-3" /> Nova conta
                  </button>
                </div>

                {drafts.length === 0 && (
                  <div className="text-xs italic p-3 rounded" style={{ color: "var(--text-muted)", backgroundColor: "rgba(0,0,0,0.2)", border: "1px dashed var(--border)" }}>
                    Nenhuma conta. Crie uma com o botão acima.
                  </div>
                )}

                {drafts.map((d) => {
                  const live = accountsById.get(d.id);
                  const msg = actionMsg[d.id];
                  return (
                    <div
                      key={d.id}
                      className="rounded-lg p-3 space-y-3"
                      style={{
                        backgroundColor: d.toDelete ? "rgba(239,68,68,0.05)" : "rgba(0,0,0,0.25)",
                        border: `1px solid ${d.toDelete ? "rgba(239,68,68,0.4)" : "var(--border)"}`,
                      }}
                    >
                      {/* Account header */}
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="flex flex-col gap-1">
                          {d.isNew ? (
                            <input
                              value={d.id}
                              onChange={(e) => updateDraft(d.id, { id: e.target.value.trim() })}
                              placeholder="id da conta (ex: main)"
                              className="rounded px-2 py-1 text-sm font-mono"
                              style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                            />
                          ) : (
                            <span className="font-mono text-sm" style={{ color: "var(--text-primary)" }}>
                              {d.id}
                              {d.isNew && <span className="ml-2 text-xs" style={{ color: "#34d399" }}>(nova)</span>}
                            </span>
                          )}
                          {live && (
                            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                              Status: <strong style={{ color: live.sessionStatus === "connected" ? "#34d399" : "#facc15" }}>{live.sessionStatus}</strong>
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => updateDraft(d.id, { toDelete: !d.toDelete })}
                            className="flex items-center gap-1 text-xs px-2 py-1 rounded"
                            style={{
                              backgroundColor: d.toDelete ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.04)",
                              color: d.toDelete ? "#fca5a5" : "var(--text-secondary)",
                              border: `1px solid ${d.toDelete ? "rgba(239,68,68,0.4)" : "var(--border)"}`,
                            }}
                            title={d.toDelete ? "Cancelar remoção" : "Marcar para remover"}
                          >
                            <Trash2 className="w-3 h-3" />
                            {d.toDelete ? "Cancelar" : "Remover"}
                          </button>
                        </div>
                      </div>

                      {!d.toDelete && (
                        <>
                          {/* Form */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <label className="block text-xs space-y-1">
                              <span style={{ color: "var(--text-secondary)" }}>Número de Telefone de Origem (ID ou Número)</span>
                              <input
                                value={d.phoneNumber}
                                onChange={(e) => updateDraft(d.id, { phoneNumber: e.target.value })}
                                placeholder="ex: 5511999999999"
                                className="w-full rounded px-2 py-1.5 text-sm font-mono"
                                style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                              />
                            </label>

                            <label className="block text-xs space-y-1">
                              <span style={{ color: "var(--text-secondary)" }}>Destinatário de Testes / Alertas (chatId - Opcional)</span>
                              <div className="flex items-center gap-1">
                                <input
                                  value={d.chatId}
                                  onChange={(e) => updateDraft(d.id, { chatId: e.target.value })}
                                  placeholder="ex: 5511988888888 (opcional)"
                                  className="flex-1 rounded px-2 py-1.5 text-sm font-mono"
                                  style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                                />
                                {d.chatId && (
                                  <button
                                    type="button"
                                    onClick={() => copy(`chat-${d.id}`, d.chatId)}
                                    className="p-1.5 rounded"
                                    style={{ color: "var(--text-muted)", backgroundColor: "rgba(255,255,255,0.04)", border: "1px solid var(--border)" }}
                                    title="Copiar"
                                  >
                                    {copiedKey === `chat-${d.id}` ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                  </button>
                                )}
                              </div>
                            </label>

                            <label className="block text-xs space-y-1">
                              <span style={{ color: "var(--text-secondary)" }}>DM Policy específica</span>
                              <select
                                value={d.dmPolicy}
                                onChange={(e) => updateDraft(d.id, { dmPolicy: e.target.value })}
                                className="w-full rounded px-2 py-1.5 text-sm"
                                style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                              >
                                {DM_POLICIES.map((p) => (
                                  <option key={p.value} value={p.value}>{p.label}</option>
                                ))}
                              </select>
                            </label>
                          </div>

                          {/* Diagnostics Block */}
                          {live?.diagnostics && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                              <DiagBlock
                                title="Sessão API"
                                icon={Smartphone}
                                ok={live.diagnostics.connected}
                                summary={
                                  live.diagnostics.connected
                                    ? "Conexão com a rede WhatsApp ativa"
                                    : live.diagnostics.error || "Desconectado"
                                }
                                details={
                                  live.diagnostics.connected ? (
                                    <>
                                      <div>ID: <code>{live.id}</code></div>
                                      <div>Telefone de Origem: {live.phoneNumber || "não configurado"}</div>
                                    </>
                                  ) : (
                                    <div>Inicie o pareamento do WhatsApp Web abaixo para conectar a conta.</div>
                                  )
                                }
                              />
                              <DiagBlock
                                title="Fila de Envio"
                                icon={Inbox}
                                ok={live.sessionStatus === "connected"}
                                summary={
                                  live.sessionStatus === "connected"
                                    ? "Pronto para receber alertas"
                                    : "Fila inativa"
                                }
                                details={
                                  <div>Nenhum atraso ou travamento detectado no buffer de mensagens.</div>
                                }
                              />
                            </div>
                          )}

                          {/* Per-account actions */}
                          <div className="flex flex-col gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                onClick={() => sendTest(d.id)}
                                disabled={actionBusy !== null || !d.chatId}
                                title={!d.chatId ? "Preencha o destinatário primeiro" : "Envia uma mensagem de teste agora"}
                                className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded disabled:opacity-50"
                                style={{ backgroundColor: "rgba(16,185,129,0.1)", color: "#6ee7b7", border: "1px solid rgba(16,185,129,0.3)" }}
                              >
                                {actionBusy === `test-${d.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                                Enviar mensagem de teste
                              </button>

                              <button
                                onClick={() => {
                                  if (pairingAccountId === d.id) {
                                    void stopPairing(d.id);
                                  } else {
                                    void startPairing(d.id);
                                  }
                                }}
                                disabled={actionBusy !== null}
                                className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded"
                                style={{
                                  backgroundColor: pairingAccountId === d.id ? "rgba(239,68,68,0.1)" : "rgba(139,92,246,0.1)",
                                  color: pairingAccountId === d.id ? "#fca5a5" : "#c4b5fd",
                                  border: `1px solid ${pairingAccountId === d.id ? "rgba(239,68,68,0.3)" : "rgba(139,92,246,0.3)"}`,
                                }}
                              >
                                {pairingLoading && pairingAccountId === d.id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Smartphone className="w-3.5 h-3.5" />
                                )}
                                {pairingAccountId === d.id ? "Parar Pareamento" : "Parear via QR Code"}
                              </button>

                              {msg && (
                                <span className="text-[11px]" style={{ color: msg.kind === "ok" ? "#34d399" : "#fca5a5" }}>
                                  {msg.text}
                                </span>
                              )}
                            </div>

                            {pairingAccountId === d.id && (
                              <div className="mt-2 p-3 rounded-lg border border-purple-500/30 bg-black/60 space-y-2">
                                <div className="flex items-center justify-between">
                                  <span className="text-xs font-semibold text-purple-300 flex items-center gap-1.5">
                                    <span className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
                                    Painel de Login do WhatsApp Web
                                  </span>
                                  <button
                                    onClick={() => stopPairing(d.id)}
                                    className="text-[11px] px-2 py-0.5 rounded bg-red-950/40 hover:bg-red-900/40 text-red-300 border border-red-900/30"
                                  >
                                    Fechar
                                  </button>
                                </div>
                                <p className="text-[11px] text-gray-400">
                                  Abra o WhatsApp no celular → <strong>Aparelhos Conectados</strong> → escaneie o código abaixo.
                                </p>

                                {pairingError ? (
                                  <div className="text-xs space-y-1 p-3 rounded bg-red-950/40 border border-red-900/50">
                                    <div className="text-red-300 font-medium flex items-center gap-1">
                                      <XCircle className="w-3.5 h-3.5" /> {pairingError.error}
                                    </div>
                                    {pairingError.hint && (
                                      <div className="text-yellow-300 text-[11px]">{pairingError.hint}</div>
                                    )}
                                  </div>
                                ) : pairingConnected ? (
                                  <div className="text-xs p-3 rounded bg-emerald-950/40 border border-emerald-700/40 text-emerald-300 flex items-center gap-1.5">
                                    <CheckCircle2 className="w-4 h-4" /> {pairingMessage || "WhatsApp conectado com sucesso."}
                                  </div>
                                ) : pairingQrDataUrl ? (
                                  <div className="flex flex-col items-center gap-2">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                      src={pairingQrDataUrl}
                                      alt="QR Code WhatsApp"
                                      className="bg-white p-3 rounded-lg"
                                      style={{
                                        width: "min(320px, 80vw)",
                                        height: "min(320px, 80vw)",
                                        imageRendering: "pixelated",
                                        border: "1px solid rgba(255,255,255,0.15)",
                                      }}
                                    />
                                    {pairingMessage && (
                                      <span className="text-[11px] text-gray-400">{pairingMessage}</span>
                                    )}
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-2 text-xs text-gray-400 p-3">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    {pairingMessage || "Aguardando QR do gateway…"}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </>
                      )}

                      {d.toDelete && (
                        <div className="text-xs" style={{ color: "#fca5a5" }}>
                          Esta conta será removida ao salvar. Clique em &quot;Cancelar&quot; para manter.
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Recent activity */}
              {recentActivity.length > 0 && (
                <div className="rounded-lg p-3" style={{ backgroundColor: "rgba(0,0,0,0.2)", border: "1px solid var(--border)" }}>
                  <h3 className="text-xs uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>
                    Atividade recente (do log do AtlasDeck)
                  </h3>
                  <ul className="text-xs space-y-1 max-h-40 overflow-auto">
                    {recentActivity.map((a, i) => (
                      <li key={i} className="flex items-start gap-2">
                        {a.status === "success" ? (
                          <CheckCircle2 className="w-3 h-3 mt-0.5 text-emerald-400 shrink-0" />
                        ) : (
                          <XCircle className="w-3 h-3 mt-0.5 text-red-400 shrink-0" />
                        )}
                        <span style={{ color: "var(--text-secondary)" }}>
                          <span style={{ color: "var(--text-muted)" }}>{new Date(a.timestamp).toLocaleString("pt-BR")} · </span>
                          {a.description}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        <RestartStatusBanner
          restarting={restarting}
          result={restartResult}
          successHint="token já está ativo no OpenClaw"
        />

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t gap-3 flex-wrap" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center gap-3 flex-wrap text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer select-none" style={{ color: "var(--text-secondary)" }}>
              <input
                type="checkbox"
                checked={autoRestart}
                onChange={(e) => updateAutoRestart(e.target.checked)}
                className="cursor-pointer"
              />
              Reiniciar gateway ao salvar
            </label>
            {saveMsg && (
              <span style={{ color: saveMsg.kind === "ok" ? "#34d399" : "#fca5a5" }}>{saveMsg.text}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded-lg"
              style={{ backgroundColor: "rgba(255,255,255,0.04)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
            >
              Fechar
            </button>
            <button
              onClick={onSave}
              disabled={saving || restarting || !data}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg font-medium disabled:opacity-50"
              style={{ backgroundColor: "rgba(139,92,246,0.2)", color: "#c4b5fd", border: "1px solid rgba(139,92,246,0.4)" }}
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {saving ? "Salvando…" : autoRestart ? "Salvar e aplicar" : "Salvar alterações"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DiagBlock({
  title,
  icon: Icon,
  ok,
  summary,
  details,
}: {
  title: string;
  icon: any;
  ok: boolean;
  summary: string;
  details: React.ReactNode;
}) {
  return (
    <div
      className="rounded p-2 space-y-1"
      style={{
        backgroundColor: ok ? "rgba(16,185,129,0.05)" : "rgba(234,179,8,0.06)",
        border: `1px solid ${ok ? "rgba(16,185,129,0.25)" : "rgba(234,179,8,0.3)"}`,
      }}
    >
      <div className="flex items-center gap-1.5">
        <Icon className="w-3 h-3" style={{ color: ok ? "#34d399" : "#facc15" }} />
        <span className="font-medium text-[11px] uppercase tracking-wider" style={{ color: "var(--text-secondary)" }}>{title}</span>
        {ok ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : <AlertTriangle className="w-3 h-3 text-yellow-400" />}
      </div>
      <div className="text-[11px]" style={{ color: "var(--text-primary)" }}>{summary}</div>
      <div className="text-[10px] space-y-0.5" style={{ color: "var(--text-muted)" }}>
        {details}
      </div>
    </div>
  );
}
