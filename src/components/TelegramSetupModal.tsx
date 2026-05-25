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
  Bot,
  Webhook,
  Inbox,
  Copy,
  Check,
  Plus,
  FileText,
  Power,
  Zap,
  AlertCircle,
} from "lucide-react";
import {
  restartGatewayClient,
  getAutoRestartPref,
  setAutoRestartPref,
  type ClientRestartResult,
} from "@/lib/restart-gateway-client";

interface TelegramAccount {
  id: string;
  hasToken: boolean;
  tokenMasked: string;
  token: string | null;
  chatId: string | null;
  dmPolicy: string | null;
  diagnostics: null | {
    bot: {
      ok: boolean;
      result?: {
        id: number;
        is_bot: boolean;
        first_name: string;
        username?: string;
        can_join_groups?: boolean;
        can_read_all_group_messages?: boolean;
        supports_inline_queries?: boolean;
      };
      description?: string;
      networkError?: string;
      httpStatus?: number;
      errorCode?: number;
    };
    webhook: {
      ok: boolean;
      result?: {
        url: string;
        has_custom_certificate: boolean;
        pending_update_count: number;
        ip_address?: string;
        last_error_date?: number;
        last_error_message?: string;
        last_synchronization_error_date?: number;
        max_connections?: number;
        allowed_updates?: string[];
      };
      description?: string;
      networkError?: string;
    };
    updates: {
      ok: boolean;
      count: number;
      latestText?: string;
      latestFrom?: string;
      latestDate?: number;
      error?: string;
    };
  };
}

interface TelegramConfigResponse {
  config: {
    path: string;
    isFallback: boolean;
    enabled: boolean;
    dmPolicy: string;
  };
  accounts: TelegramAccount[];
  recentActivity: Array<{ timestamp: string; status: string; description: string }>;
  summary: { healthy: boolean; issues: string[] };
  timestamp: string;
  error?: string;
}

interface AccountDraft {
  id: string;          // immutable for existing, editable for new
  isNew: boolean;
  hasExistingToken: boolean;
  token: string;       // "" means clear, undefined-equivalent handled separately
  tokenTouched: boolean;
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

function tsToDate(ts?: number): string | null {
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleString("pt-BR");
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function TelegramSetupModal({ open, onClose }: Props) {
  const [data, setData] = useState<TelegramConfigResponse | null>(null);
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

  // Auto-restart of gateway after saving Telegram config (so the daemon picks
  // up the new token without a manual restart step)
  const [autoRestart, setAutoRestart] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<ClientRestartResult | null>(null);

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
      const url = `/api/integrations/telegram?live=1${opts.reveal ? "&revealToken=1" : ""}`;
      const res = await fetch(url, { cache: "no-store" });
      const json: TelegramConfigResponse = await res.json();
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

  const addAccount = () => {
    const baseId = "account";
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
      const accounts: Record<string, { botToken?: string; chatId?: string; dmPolicy?: string }> = {};
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
        const patch: { botToken?: string; chatId?: string; dmPolicy?: string } = {
          chatId: d.chatId,
          dmPolicy: d.dmPolicy,
        };
        // Only send botToken if user touched the field (so we don't overwrite with empty)
        if (d.tokenTouched) patch.botToken = d.token;
        // For brand-new account without token, force empty string so backend rejects? No — allow empty to allow setting chatId only later.
        if (d.isNew && !d.tokenTouched) patch.botToken = "";
        accounts[d.id] = patch;
      }

      const res = await fetch("/api/integrations/telegram", {
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
      // Auto-restart the gateway so OpenClaw picks up the new token/policy.
      // Without this, the daemon keeps using the previous credentials in memory.
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
      // Pass the draft token (unsaved) so the user can test before clicking Save.
      // Backend prefers body.token over the persisted JSON value.
      const draftToken = draft?.tokenTouched ? draft.token.trim() : "";
      const res = await fetch(`/api/integrations/telegram?action=test`, {
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

  const clearWebhook = async (accountId: string) => {
    const key = `clear-${accountId}`;
    setActionBusy(key);
    try {
      const res = await fetch(`/api/integrations/telegram?action=clear-webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setActionMsg((m) => ({ ...m, [accountId]: { kind: "ok", text: "Webhook removido — polling pode voltar a funcionar" } }));
      await refresh();
    } catch (e) {
      setActionMsg((m) => ({
        ...m,
        [accountId]: { kind: "err", text: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      setActionBusy(null);
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
    const map = new Map<string, TelegramAccount>();
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
            <Bot className="w-5 h-5" style={{ color: "var(--accent)" }} />
            <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
              Telegram — configuração & diagnóstico
            </h2>
          </div>
          <div className="flex items-center gap-2">
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
                    {data.summary.healthy ? "Telegram operacional" : `Encontrei ${issues.length} ponto${issues.length === 1 ? "" : "s"} para revisar`}
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
                    Canal habilitado (<code>channels.telegram.enabled</code>)
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
                    Contas (bots)
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
                    Nenhuma conta. Crie uma com o botão acima e cole o token vindo do <code>@BotFather</code>.
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
                          {live?.diagnostics?.bot?.ok && live.diagnostics.bot.result && (
                            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                              Bot: <strong>@{live.diagnostics.bot.result.username || "?"}</strong> · {live.diagnostics.bot.result.first_name} · id {live.diagnostics.bot.result.id}
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
                              <span style={{ color: "var(--text-secondary)" }}>Bot Token</span>
                              <div className="flex items-center gap-1">
                                <input
                                  type={d.showToken ? "text" : "password"}
                                  value={d.token}
                                  onChange={(e) => updateDraft(d.id, { token: e.target.value, tokenTouched: true })}
                                  placeholder={d.hasExistingToken ? live?.tokenMasked || "•••••" : "123456:ABC-DEF..."}
                                  className="flex-1 rounded px-2 py-1.5 text-sm font-mono"
                                  style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                                />
                                <button
                                  type="button"
                                  onClick={() => updateDraft(d.id, { showToken: !d.showToken })}
                                  className="p-1.5 rounded"
                                  style={{ color: "var(--text-muted)", backgroundColor: "rgba(255,255,255,0.04)", border: "1px solid var(--border)" }}
                                  title={d.showToken ? "Esconder" : "Mostrar"}
                                >
                                  {d.showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                </button>
                                {!d.tokenTouched && d.hasExistingToken && !d.showToken && (
                                  <button
                                    type="button"
                                    onClick={() => refresh({ reveal: true })}
                                    className="p-1.5 rounded text-xs"
                                    style={{ color: "var(--text-muted)", backgroundColor: "rgba(255,255,255,0.04)", border: "1px solid var(--border)" }}
                                    title="Buscar token atual para editar"
                                  >
                                    carregar
                                  </button>
                                )}
                              </div>
                              <span className="block text-[10px]" style={{ color: "var(--text-muted)" }}>
                                {d.hasExistingToken && !d.tokenTouched
                                  ? "Token já configurado — deixe em branco para manter, ou edite para substituir."
                                  : "Cole o token fornecido pelo @BotFather (formato 123456:ABC-DEF...)"}
                              </span>
                            </label>

                            <label className="block text-xs space-y-1">
                              <span style={{ color: "var(--text-secondary)" }}>Chat ID (para alertas proativos)</span>
                              <div className="flex items-center gap-1">
                                <input
                                  value={d.chatId}
                                  onChange={(e) => updateDraft(d.id, { chatId: e.target.value })}
                                  placeholder="ex: 123456789 ou -1001234567890"
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
                              <span className="block text-[10px]" style={{ color: "var(--text-muted)" }}>
                                Descubra o seu enviando uma mensagem ao bot e olhando o resultado de getUpdates abaixo.
                              </span>
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

                          {/* Live diagnostics */}
                          {live?.diagnostics && (
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                              {/* Bot */}
                              <DiagBlock
                                title="getMe"
                                icon={Bot}
                                ok={live.diagnostics.bot.ok}
                                summary={
                                  live.diagnostics.bot.ok && live.diagnostics.bot.result
                                    ? `@${live.diagnostics.bot.result.username || "?"} ok`
                                    : live.diagnostics.bot.description || live.diagnostics.bot.networkError || "?"
                                }
                                details={
                                  live.diagnostics.bot.ok && live.diagnostics.bot.result ? (
                                    <>
                                      <div>id: <code>{live.diagnostics.bot.result.id}</code></div>
                                      <div>nome: {live.diagnostics.bot.result.first_name}</div>
                                      <div>join groups: {String(!!live.diagnostics.bot.result.can_join_groups)}</div>
                                      <div>lê todas no grupo: {String(!!live.diagnostics.bot.result.can_read_all_group_messages)}</div>
                                      <div>inline: {String(!!live.diagnostics.bot.result.supports_inline_queries)}</div>
                                    </>
                                  ) : (
                                    <div>HTTP {live.diagnostics.bot.httpStatus ?? "?"} · code {live.diagnostics.bot.errorCode ?? "?"}</div>
                                  )
                                }
                              />
                              {/* Webhook */}
                              <DiagBlock
                                title="getWebhookInfo"
                                icon={Webhook}
                                ok={live.diagnostics.webhook.ok && !live.diagnostics.webhook.result?.last_error_message}
                                summary={
                                  !live.diagnostics.webhook.ok
                                    ? live.diagnostics.webhook.description || "falhou"
                                    : live.diagnostics.webhook.result?.url
                                      ? `webhook ativo (${live.diagnostics.webhook.result.pending_update_count} pendentes)`
                                      : `polling (sem webhook)`
                                }
                                details={
                                  live.diagnostics.webhook.result ? (
                                    <>
                                      <div>url: <span className="break-all">{live.diagnostics.webhook.result.url || "(vazio)"}</span></div>
                                      <div>pendentes: {live.diagnostics.webhook.result.pending_update_count}</div>
                                      {live.diagnostics.webhook.result.ip_address && (
                                        <div>ip: {live.diagnostics.webhook.result.ip_address}</div>
                                      )}
                                      {live.diagnostics.webhook.result.last_error_message && (
                                        <div style={{ color: "#fca5a5" }}>
                                          erro: {live.diagnostics.webhook.result.last_error_message}
                                          {live.diagnostics.webhook.result.last_error_date && (
                                            <span> ({tsToDate(live.diagnostics.webhook.result.last_error_date)})</span>
                                          )}
                                        </div>
                                      )}
                                      {live.diagnostics.webhook.result.url && (
                                        <button
                                          onClick={() => clearWebhook(d.id)}
                                          disabled={actionBusy !== null}
                                          className="mt-1 inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded disabled:opacity-50"
                                          style={{ backgroundColor: "rgba(239,68,68,0.1)", color: "#fca5a5", border: "1px solid rgba(239,68,68,0.3)" }}
                                        >
                                          {actionBusy === `clear-${d.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                          Limpar webhook
                                        </button>
                                      )}
                                    </>
                                  ) : (
                                    <div>{live.diagnostics.webhook.description || "—"}</div>
                                  )
                                }
                              />
                              {/* Updates */}
                              <DiagBlock
                                title="getUpdates"
                                icon={Inbox}
                                ok={live.diagnostics.updates.ok}
                                summary={
                                  live.diagnostics.updates.ok
                                    ? `${live.diagnostics.updates.count} update(s) recentes`
                                    : live.diagnostics.updates.error || "falhou"
                                }
                                details={
                                  live.diagnostics.updates.ok && live.diagnostics.updates.count > 0 ? (
                                    <>
                                      <div>último de: {live.diagnostics.updates.latestFrom || "?"}</div>
                                      <div>texto: <em>{(live.diagnostics.updates.latestText || "(sem texto)").slice(0, 60)}</em></div>
                                      <div>em: {tsToDate(live.diagnostics.updates.latestDate) || "?"}</div>
                                    </>
                                  ) : (
                                    <div>{live.diagnostics.updates.error || "Nenhum update novo. Envie /start ao bot para popular."}</div>
                                  )
                                }
                              />
                            </div>
                          )}

                          {/* Per-account actions */}
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              onClick={() => sendTest(d.id)}
                              disabled={actionBusy !== null || !d.chatId}
                              title={!d.chatId ? "Preencha o chatId primeiro" : "Envia uma mensagem de teste agora"}
                              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded disabled:opacity-50"
                              style={{ backgroundColor: "rgba(16,185,129,0.1)", color: "#6ee7b7", border: "1px solid rgba(16,185,129,0.3)" }}
                            >
                              {actionBusy === `test-${d.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                              Enviar mensagem de teste
                            </button>
                            {msg && (
                              <span className="text-[11px]" style={{ color: msg.kind === "ok" ? "#34d399" : "#fca5a5" }}>
                                {msg.text}
                              </span>
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

        {/* Restart status row */}
        {(restarting || restartResult) && (
          <div
            className="px-5 py-2 border-t flex items-start gap-2 text-xs"
            style={{
              borderColor: "var(--border)",
              backgroundColor: restarting
                ? "rgba(139, 92, 246, 0.08)"
                : restartResult?.success
                  ? "rgba(16, 185, 129, 0.08)"
                  : "rgba(239, 68, 68, 0.08)",
            }}
          >
            {restarting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 mt-0.5 shrink-0 animate-spin" style={{ color: "#a78bfa" }} />
                <span style={{ color: "var(--text-primary)" }}>Aplicando — reiniciando o gateway…</span>
              </>
            ) : restartResult?.success ? (
              <>
                <Zap className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "#34d399" }} />
                <span style={{ color: "#34d399" }}>
                  Gateway reiniciado em {(restartResult.durationMs / 1000).toFixed(1)}s · token já está ativo no OpenClaw
                </span>
              </>
            ) : (
              <>
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "#fca5a5" }} />
                <div className="flex-1 min-w-0">
                  <div style={{ color: "#fca5a5" }}>
                    Config salva, mas restart do gateway falhou — daemon ainda usa o token antigo em memória.
                  </div>
                  {restartResult?.error && (
                    <div className="mt-0.5" style={{ color: "var(--text-muted)" }}>
                      {restartResult.error.slice(0, 200)}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

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
  icon: typeof Bot;
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
