"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type OperationMode = "passive" | "owner" | "assistant" | "open" | "pairing";

interface WhatsappAccount {
  id: string;
  hasToken: boolean;
  tokenMasked: string;
  token: string | null;
  phoneNumber: string | null;
  chatId: string | null;
  dmPolicy: string | null;
  operationMode: OperationMode;
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
  operationMode: OperationMode;
  showToken: boolean;
  toDelete: boolean;
}

const OPERATION_MODES: Array<{
  value: OperationMode;
  label: string;
  hint: string;
}> = [
  {
    value: "passive",
    label: "🔇 Passivo (recomendado — bot recebe mas não responde)",
    hint: "DMs entregues à conta WhatsApp não são roteadas pro agente. Grupos também ignorados. Ninguém recebe resposta automática.",
  },
  {
    value: "owner",
    label: "👤 Responder como você (primeira pessoa)",
    hint: "Bot responde DMs como se fosse você (primeira pessoa, tom casual, busca memórias antes de responder, áudio via voz clonada Fish Audio). Grupos: só responde se você for mencionado. Comandos do seu próprio número aceitos (selfChatMode).",
  },
  {
    value: "assistant",
    label: "🤝 Responder como seu assessor (terceira pessoa)",
    hint: "Bot se apresenta como assessor profissional, anota recados, marca reuniões (calendário), NÃO expõe suas memórias pessoais. Comandos administrativos só do seu número. Quando você pedir 'briefing' ele resume quem falou com ele.",
  },
  {
    value: "open",
    label: "🌐 Bot livre (responde com a personalidade do agente)",
    hint: "Sem persona injetada. Bot responde com a voz padrão do agente. Útil pra sandbox/testes — não recomendado pra WhatsApp pessoal.",
  },
  {
    value: "pairing",
    label: "🔐 Pareamento manual (legado — envia código pra cada novo contato)",
    hint: "Desconhecidos recebem código de pareamento pra você aprovar via CLI. Pode spammar contatos — só use se entender.",
  },
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
  // Mode chosen at the channel level. Defaults to "passive" so a freshly-
  // configured WhatsApp instance never replies until the user picks a mode.
  const [globalOperationMode, setGlobalOperationMode] = useState<OperationMode>("passive");
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
  const [pairingOutput, setPairingOutput] = useState<string>("");
  const [pairingExited, setPairingExited] = useState<boolean>(false);
  const [pairingLoading, setPairingLoading] = useState<boolean>(false);
  const pairingPanelRef = useRef<HTMLPreElement | null>(null);

  // Auto-scroll the terminal panel so the QR/latest log lines are visible
  // without the user having to manually drag the scrollbar. Triggered on
  // every polling tick that updates pairingOutput.
  useEffect(() => {
    const el = pairingPanelRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pairingOutput]);

  // Detect the QR ASCII block in the pair output and split it off so we can
  // render the QR in a dedicated compact white panel (so the camera can
  // actually frame it) while the verbose logs stay in the dark terminal
  // panel. A "QR line" is a non-empty line that contains only U+2588 (full
  // block) characters and spaces — that's what qrAnsiBgToBlocks produces.
  // We walk backwards to find the LATEST QR block (Baileys refreshes the QR
  // every ~20s so older blocks are stale).
  const { qr: pairingQrBlock, rest: pairingLogText } = useMemo(() => {
    const lines = pairingOutput.split("\n");
    if (lines.length === 0) return { qr: null as string | null, rest: pairingOutput };
    const isQrLine = (l: string) => l.length > 0 && l.replace(/[ █]/g, "") === "";

    let end = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (isQrLine(lines[i])) {
        end = i + 1;
        break;
      }
      // stop searching after a few non-QR lines past the end
      if (end === -1 && lines.length - i > 80) break;
    }
    if (end === -1) return { qr: null as string | null, rest: pairingOutput };

    let start = end;
    while (start > 0 && (isQrLine(lines[start - 1]) || lines[start - 1].trim() === "")) {
      start--;
    }
    if (end - start < 5) return { qr: null as string | null, rest: pairingOutput };

    // Strip leading/trailing all-blank lines so the white panel hugs the QR.
    const qrLines = lines.slice(start, end);
    while (qrLines.length > 0 && qrLines[0].trim() === "") qrLines.shift();
    while (qrLines.length > 0 && qrLines[qrLines.length - 1].trim() === "") qrLines.pop();
    const qr = qrLines.join("\n");

    const rest = [...lines.slice(0, start), ...lines.slice(end)].join("\n");
    return { qr, rest };
  }, [pairingOutput]);

  // Convert the ASCII QR (█ + spaces) into a binary matrix, then draw it as
  // a pixel-perfect PNG via Canvas. Unicode block chars in monospace fonts
  // don't line up to square cells (vertical padding, kerning), which makes
  // the rendered QR look rectangular and breaks phone-camera autofocus +
  // QR decoders. Drawing it on a canvas eliminates ALL that — clean black
  // squares on white, square cells, any size we want.
  const pairingQrDataUrl = useMemo(() => {
    if (!pairingQrBlock) return null;
    if (typeof document === "undefined") return null;

    const lines = pairingQrBlock.split("\n");

    // Trim leading-space prefix shared by every line so the QR is left-aligned.
    let leadingTrim = Infinity;
    for (const l of lines) {
      if (l.trim().length === 0) continue;
      const m = l.match(/^ */);
      if (m) leadingTrim = Math.min(leadingTrim, m[0].length);
    }
    if (!Number.isFinite(leadingTrim)) leadingTrim = 0;

    // Each QR module is 2 chars wide × 1 line tall in qrcode npm's terminal
    // output (small:false). A module is "dark" when its 2 chars are █.
    const matrix: boolean[][] = [];
    let maxCols = 0;
    for (const line of lines) {
      const trimmed = line.slice(leadingTrim);
      if (trimmed.trim().length === 0 && matrix.length === 0) continue;
      const row: boolean[] = [];
      for (let i = 0; i + 1 < trimmed.length; i += 2) {
        const c = trimmed[i];
        row.push(c === "█");
      }
      if (row.length > 0) {
        matrix.push(row);
        if (row.length > maxCols) maxCols = row.length;
      }
    }
    if (matrix.length === 0 || maxCols === 0) return null;

    // Pad ragged rows so the canvas grid is uniform.
    for (const row of matrix) {
      while (row.length < maxCols) row.push(false);
    }

    // Render at integer-pixel cell size so the QR stays crisp at any zoom.
    const cellPx = 8;
    const w = maxCols * cellPx;
    const h = matrix.length * cellPx;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#000000";
    for (let r = 0; r < matrix.length; r++) {
      for (let c = 0; c < matrix[r].length; c++) {
        if (matrix[r][c]) ctx.fillRect(c * cellPx, r * cellPx, cellPx, cellPx);
      }
    }
    return canvas.toDataURL("image/png");
  }, [pairingQrBlock]);

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
      // Mirror the inference the backend does: any stored value other than
      // open/pairing collapses to "passive" so an unconfigured / "off" /
      // "disabled" account presents as passive in the UI.
      const fromChannel: OperationMode =
        json.config.dmPolicy === "open"
          ? "open"
          : json.config.dmPolicy === "pairing"
            ? "pairing"
            : "passive";
      // Prefer the first account's operationMode (single-account is the norm
      // for WhatsApp). Falls back to the channel-level inference.
      const firstMode = json.accounts[0]?.operationMode as OperationMode | undefined;
      setGlobalOperationMode(firstMode ?? fromChannel);
      setDrafts(
        json.accounts.map((a) => ({
          id: a.id,
          isNew: false,
          hasExistingToken: a.hasToken,
          token: a.token ?? "",
          tokenTouched: false,
          phoneNumber: a.phoneNumber ?? "",
          chatId: a.chatId ?? "",
          operationMode: (a.operationMode as OperationMode) || fromChannel,
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

  // Pareamento via PTY: spawn `script -qfc 'openclaw channels login ...' /dev/null`
  // server-side, polling buffer'd output. `whatsapp_login` HTTP tool não existe em
  // v2026.5.12 (toolNames: []), então o caminho oficial é o CLI com TTY alocado.
  useEffect(() => {
    if (!pairingAccountId) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let isActive = true;

    async function poll() {
      try {
        const res = await fetch(`/api/integrations/whatsapp/pair?accountId=${pairingAccountId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!isActive) return;

        setPairingOutput(data.output ?? "");
        setPairingExited(!!data.exited);

        const lowerOut = (data.output || "").toLowerCase();
        if (
          lowerOut.includes("session connected") ||
          lowerOut.includes("logged in") ||
          lowerOut.includes("conectado") ||
          data.exitCode === 0
        ) {
          void refresh();
        }

        if (!data.exited) {
          timer = setTimeout(poll, 1500);
        }
      } catch (err) {
        if (!isActive) return;
        console.error("Erro no polling do pareamento:", err);
      }
    }

    void poll();

    return () => {
      isActive = false;
      if (timer) clearTimeout(timer);
    };
  }, [pairingAccountId, refresh]);

  const startPairing = async (accountId: string) => {
    setPairingAccountId(accountId);
    setPairingOutput("Iniciando terminal e gerando QR Code…");
    setPairingExited(false);
    setPairingLoading(true);
    try {
      const res = await fetch(`/api/integrations/whatsapp/pair?action=start&accountId=${accountId}`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.success) {
        setPairingOutput(data.output || "Aguardando terminal…");
      } else {
        setPairingOutput(`Erro: ${data.error}`);
      }
    } catch (e) {
      setPairingOutput(`Erro ao conectar à API: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPairingLoading(false);
    }
  };

  const stopPairing = async (accountId: string) => {
    try {
      await fetch(`/api/integrations/whatsapp/pair?action=stop&accountId=${accountId}`, {
        method: "POST",
      });
    } catch {}
    setPairingAccountId(null);
    setPairingOutput("");
    setPairingExited(true);
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
        // New accounts inherit the channel-level mode. If the user is in
        // the safe default (passive), the new account stays passive too.
        operationMode: globalOperationMode,
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
      const accounts: Record<
        string,
        { token?: string; phoneNumber?: string; chatId?: string; operationMode?: OperationMode }
      > = {};
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
        const patch: {
          token?: string;
          phoneNumber?: string;
          chatId?: string;
          operationMode?: OperationMode;
        } = {
          phoneNumber: d.phoneNumber,
          chatId: d.chatId,
          operationMode: d.operationMode,
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
          operationMode: globalOperationMode,
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
      const installs: Array<{
        package: string;
        alreadyInstalled: boolean;
        ok: boolean;
        durationMs: number;
        outputTail: string;
      }> = Array.isArray(json.installs) ? json.installs : [];
      const restart = json.restart || {};

      const bits: string[] = [];
      for (const i of installs) {
        if (i.alreadyInstalled) {
          bits.push(`${i.package} já instalado`);
        } else if (i.ok) {
          bits.push(`${i.package} instalado (${(i.durationMs / 1000).toFixed(1)}s)`);
        } else {
          bits.push(`${i.package} FALHOU`);
        }
      }
      if (sweep.changedWhatsapp) bits.push("WhatsApp sanitizado");
      if (sweep.changedTelegram) bits.push("Telegram sanitizado");
      if (sweep.changedGatewayToolsAllow) bits.push("whatsapp_login liberado no gateway");
      if (Array.isArray(sweep.changedPluginsEnabled) && sweep.changedPluginsEnabled.length > 0) {
        bits.push(`plugins enabled: ${sweep.changedPluginsEnabled.join(", ")}`);
      }
      if (sweep.changedWhatsappChannelDefaults) {
        bits.push("channels.whatsapp recebeu defaults obrigatórios");
      }
      if (restart.ok === true) bits.push(restart.message || "gateway reiniciado");
      else if (restart.ok === false) bits.push(`restart falhou (${restart.message ?? ""})`);

      const runtime = json.runtime || {};
      if (runtime.toolRegistered === true) {
        bits.push("whatsapp_login registrado no runtime ✓");
      } else if (runtime.toolRegistered === false) {
        bits.push("⚠ whatsapp_login NÃO registrado (veja detalhe)");
      }

      if (bits.length === 0) bits.push("config já estava OK");

      const detail =
        runtime.toolRegistered === false && runtime.outputTail
          ? `Runtime inspect (whatsapp):\n${runtime.outputTail}\n\nValidate:\n${validate.output || "(sem output)"}`
          : (validate.output || "").trim() || "(validator não respondeu)";
      const ok = !!json.ok && runtime.toolRegistered !== false;

      setRepairResult({
        ok,
        summary: ok
          ? `Reparo completo: ${bits.join(" · ")}`
          : `Reparo parcial: ${bits.join(" · ")}`,
        detail,
      });

      await refresh();
      // Backend já reiniciou o gateway dentro do repair quando necessário,
      // mas se o usuário marcou auto-restart e o backend não reiniciou,
      // chamamos o restart client (mostra o banner padrão).
      if (autoRestart && restart.ok !== true) {
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
                <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: "var(--text-primary)" }}>
                  <Power className="w-3.5 h-3.5" style={{ color: enabled ? "#34d399" : "var(--text-muted)" }} />
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                  />
                  Canal habilitado (<code>channels.whatsapp.enabled</code>)
                </label>

                <div className="space-y-1">
                  <label className="text-sm block" style={{ color: "var(--text-secondary)" }}>
                    Modo de operação global
                  </label>
                  <select
                    value={globalOperationMode}
                    onChange={(e) => setGlobalOperationMode(e.target.value as OperationMode)}
                    className="w-full rounded px-2 py-1.5 text-sm"
                    style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                  >
                    {OPERATION_MODES.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                  <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    {OPERATION_MODES.find((m) => m.value === globalOperationMode)?.hint}
                  </p>
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
                              <span style={{ color: "var(--text-secondary)" }}>Modo de operação desta conta</span>
                              <select
                                value={d.operationMode}
                                onChange={(e) =>
                                  updateDraft(d.id, { operationMode: e.target.value as OperationMode })
                                }
                                className="w-full rounded px-2 py-1.5 text-sm"
                                style={{ backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                              >
                                {OPERATION_MODES.map((m) => (
                                  <option key={m.value} value={m.value}>{m.label}</option>
                                ))}
                              </select>
                              <span className="text-[10px] block" style={{ color: "var(--text-muted)" }}>
                                {OPERATION_MODES.find((m) => m.value === d.operationMode)?.hint}
                              </span>
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
                                  Abra o WhatsApp no celular → <strong>Aparelhos Conectados</strong> → escaneie o QR abaixo.
                                </p>
                                {pairingExited && (
                                  <div className="text-xs text-yellow-400 font-medium">
                                    Terminal encerrado. Se não conectou, tente Reparar config e iniciar de novo.
                                  </div>
                                )}

                                {pairingQrDataUrl && (
                                  <div className="flex flex-col items-center gap-2">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                      src={pairingQrDataUrl}
                                      alt="QR Code WhatsApp Web"
                                      className="bg-white rounded-md"
                                      style={{
                                        width: "min(320px, 80vw)",
                                        height: "min(320px, 80vw)",
                                        imageRendering: "pixelated",
                                        padding: "12px",
                                        border: "1px solid rgba(255,255,255,0.15)",
                                      }}
                                    />
                                    <span className="text-[11px] text-gray-500">
                                      QR renderizado a partir do output do CLI (cells: pixel-perfect)
                                    </span>
                                  </div>
                                )}

                                <details open={!pairingQrDataUrl}>
                                  <summary className="text-[10px] text-gray-400 cursor-pointer select-none mb-1">
                                    {pairingQrDataUrl ? "Mostrar logs do terminal" : "Logs do terminal (aguardando QR…)"}
                                  </summary>
                                  <pre
                                    ref={pairingPanelRef}
                                    className="font-mono bg-black text-white p-3 rounded-md overflow-auto text-[10px] leading-[12px] tracking-[0px] select-text"
                                    style={{
                                      maxHeight: "240px",
                                      border: "1px solid rgba(255,255,255,0.15)",
                                      display: "block",
                                      whiteSpace: "pre",
                                      textAlign: "left",
                                    }}
                                  >
                                    {pairingLogText || pairingOutput || "Aguardando saída do CLI…"}
                                  </pre>
                                </details>
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
