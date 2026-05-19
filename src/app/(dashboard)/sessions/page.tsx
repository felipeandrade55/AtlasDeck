"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  ArrowDownUp,
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  Clock,
  Copy,
  Cpu,
  Database,
  FileText,
  Gauge,
  Hash,
  MessageCircle,
  MessageSquare,
  Radio,
  RefreshCw,
  Search,
  TimerReset,
  User,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";

interface Session {
  id: string;
  key: string;
  type: "main" | "cron" | "subagent" | "direct" | "unknown";
  typeLabel: string;
  typeIcon: string;
  agentId: string;
  sessionId: string | null;
  cronJobId?: string;
  subagentId?: string;
  channel?: string;
  updatedAt: number;
  ageMs: number;
  model: string;
  modelProvider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  contextUsedPercent: number | null;
  aborted: boolean;
  source: "sessions-list" | "status" | "files";
  hasTranscript: boolean;
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  title: string;
  transcriptUpdatedAt: number | null;
}

interface SessionsMeta {
  total: number;
  source: "sessions-list" | "status" | "files" | "unavailable";
  sources: Session["source"][];
  generatedAt: number;
  openclawDir: string;
  diagnostics: string[];
  error: string | null;
}

interface Message {
  id: string;
  type: "user" | "assistant" | "tool_use" | "tool_result" | "model_change" | "system";
  role?: string;
  content: string;
  timestamp: string;
  model?: string;
  toolName?: string;
}

type FilterType = "all" | "main" | "cron" | "subagent" | "direct" | "transcript" | "alerts";
type SortKey = "updated" | "tokens" | "messages" | "context";

const TYPE_ICONS: Record<Session["type"], LucideIcon> = {
  main: MessageSquare,
  cron: Clock,
  subagent: Bot,
  direct: MessageCircle,
  unknown: CircleHelp,
};

const SOURCE_LABELS: Record<SessionsMeta["source"] | Session["source"], string> = {
  "sessions-list": "CLI sessions",
  status: "CLI status",
  files: "JSONL",
  unavailable: "Indisponível",
};

const FILTER_TABS: Array<{ id: FilterType; label: string; icon: LucideIcon }> = [
  { id: "all", label: "Todas", icon: FileText },
  { id: "main", label: "Principal", icon: MessageSquare },
  { id: "cron", label: "Cron", icon: Clock },
  { id: "subagent", label: "Sub-agentes", icon: Bot },
  { id: "direct", label: "Chats", icon: MessageCircle },
  { id: "transcript", label: "Com transcrição", icon: Database },
  { id: "alerts", label: "Alertas", icon: AlertTriangle },
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}M`;
  if (n >= 1_000) return `${(n / 1_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}k`;
  return n.toLocaleString("pt-BR");
}

function formatNumber(n: number): string {
  return n.toLocaleString("pt-BR");
}

function shortModel(model: string): string {
  if (!model || model === "unknown") return "Modelo n/d";

  const normalized = model
    .replace("anthropic/", "")
    .replace("openai/", "")
    .replace("google/", "")
    .replace("claude-", "");
  const parts = normalized.split("-").filter(Boolean);

  let result = normalized;
  if (parts.length >= 2) {
    const name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    result = `${name} ${parts.slice(1).join(".")}`;
  }

  return result.replace("Gpt", "GPT");
}

function formatRelative(timestamp: number): string {
  if (!timestamp) return "n/d";
  return formatDistanceToNow(new Date(timestamp), { addSuffix: true, locale: ptBR });
}

function formatExact(timestamp: number): string {
  if (!timestamp) return "n/d";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(timestamp));
}

function typeColor(type: Session["type"]): string {
  switch (type) {
    case "main":
      return "var(--accent)";
    case "cron":
      return "#a78bfa";
    case "subagent":
      return "#60a5fa";
    case "direct":
      return "#32d74b";
    default:
      return "var(--text-muted)";
  }
}

function isAlertSession(session: Session): boolean {
  return session.aborted || (session.contextUsedPercent ?? 0) >= 80;
}

function sourceTone(source: SessionsMeta["source"]): CSSProperties {
  if (source === "unavailable") {
    return { color: "var(--negative)", backgroundColor: "var(--negative-soft)" };
  }
  if (source === "files") {
    return { color: "var(--warning)", backgroundColor: "var(--warning-soft)" };
  }
  return { color: "var(--positive)", backgroundColor: "var(--positive-soft)" };
}

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  color,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  detail: string;
  color: string;
}) {
  return (
    <div className="session-stat-card">
      <div
        className="session-stat-icon"
        style={{
          color,
          backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
        }}
      >
        <Icon size={18} />
      </div>
      <div className="session-stat-copy">
        <div className="session-stat-value">{value}</div>
        <div className="session-stat-label">{label}</div>
        <div className="session-stat-detail">{detail}</div>
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  if (msg.type === "tool_use") {
    return (
      <div className="message-tool">
        <Wrench size={14} />
        <span className="message-tool-name">{msg.toolName || "tool"}</span>
        <code>{msg.content || "{}"}</code>
      </div>
    );
  }

  if (msg.type === "tool_result") {
    return (
      <div className="message-result">
        <span>Resultado</span>
        <pre>{msg.content || "(sem saída)"}</pre>
      </div>
    );
  }

  if (msg.type === "model_change" || msg.type === "system") {
    return (
      <div className="message-system">
        <Cpu size={13} />
        <span>{msg.content}</span>
      </div>
    );
  }

  const isUser = msg.type === "user";

  return (
    <div className={`message-line ${isUser ? "user" : "assistant"}`}>
      <div className="message-avatar">
        {isUser ? <User size={13} /> : <Bot size={13} />}
      </div>
      <div className="message-body">
        <div className="message-meta">
          <span>{isUser ? "Usuário" : "Assistente"}</span>
          <time>{formatExact(new Date(msg.timestamp).getTime())}</time>
        </div>
        <div className="message-bubble">
          {msg.content.length > 1400 ? `${msg.content.slice(0, 1400)}...` : msg.content}
        </div>
      </div>
    </div>
  );
}

function SessionDetail({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadMessages() {
      if (!session.sessionId) {
        setMessages([]);
        setError("Esta sessão não expõe um ID de transcrição.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const res = await fetch(
          `/api/sessions?id=${encodeURIComponent(session.sessionId)}&agentId=${encodeURIComponent(session.agentId)}`,
          { cache: "no-store" }
        );
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(typeof data?.error === "string" ? data.error : "Falha ao carregar transcrição");
        }

        if (!cancelled) setMessages(Array.isArray(data.messages) ? data.messages : []);
      } catch (err) {
        if (!cancelled) {
          setMessages([]);
          setError(err instanceof Error ? err.message : "Falha ao carregar transcrição");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadMessages();
    return () => {
      cancelled = true;
    };
  }, [session.agentId, session.sessionId]);

  const copyText = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1200);
    } catch {
      setCopied(null);
    }
  };

  const TypeIcon = TYPE_ICONS[session.type] || CircleHelp;
  const color = typeColor(session.type);

  return (
    <div className="session-drawer-backdrop" onClick={onClose}>
      <aside className="session-drawer" onClick={(event) => event.stopPropagation()}>
        <header className="session-drawer-header">
          <div className="session-drawer-title-row">
            <div className="session-drawer-icon" style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}>
              <TypeIcon size={18} />
            </div>
            <div className="session-drawer-title">
              <div className="session-badges">
                <span style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}>
                  {session.typeLabel}
                </span>
                <span>{session.agentId}</span>
                {session.aborted && <span className="danger">Abortada</span>}
              </div>
              <h2>{session.title || session.key}</h2>
              <p title={session.key}>{session.key}</p>
            </div>
            <button className="icon-button" onClick={onClose} aria-label="Fechar painel">
              <X size={18} />
            </button>
          </div>

          <div className="drawer-actions">
            <button
              className="outline-action"
              onClick={() => copyText("key", session.key)}
              disabled={!session.key}
            >
              {copied === "key" ? <Check size={14} /> : <Copy size={14} />}
              Chave
            </button>
            <button
              className="outline-action"
              onClick={() => copyText("id", session.sessionId || session.id)}
            >
              {copied === "id" ? <Check size={14} /> : <Copy size={14} />}
              ID
            </button>
          </div>

          <div className="drawer-metrics">
            <span><Cpu size={13} />{shortModel(session.model)}</span>
            <span><Hash size={13} />{formatTokens(session.totalTokens)} tokens</span>
            <span><FileText size={13} />{formatNumber(session.messageCount)} mensagens</span>
            <span><Clock size={13} />{formatRelative(session.updatedAt)}</span>
          </div>
        </header>

        <section className="drawer-message-summary">
          <span>{formatNumber(session.userMessages)} usuário</span>
          <span>{formatNumber(session.assistantMessages)} assistente</span>
          <span>{formatNumber(session.toolCalls)} tools</span>
          <span>{session.hasTranscript ? "Transcrição disponível" : "Sem transcrição"}</span>
        </section>

        <section className="drawer-messages">
          {loading && (
            <div className="center-state">
              <RefreshCw className="spin" size={18} />
              Carregando transcrição...
            </div>
          )}

          {!loading && error && (
            <div className="inline-error">
              <AlertTriangle size={17} />
              {error}
            </div>
          )}

          {!loading && !error && messages.length === 0 && (
            <div className="center-state muted">
              <MessageSquare size={34} />
              Nenhuma mensagem encontrada nesta sessão.
            </div>
          )}

          {!loading && !error && messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} />
          ))}
        </section>
      </aside>
    </div>
  );
}

function SessionRow({
  session,
  onClick,
}: {
  session: Session;
  onClick: () => void;
}) {
  const color = typeColor(session.type);
  const TypeIcon = TYPE_ICONS[session.type] || CircleHelp;
  const context = session.contextUsedPercent;

  return (
    <button className="session-row" onClick={onClick}>
      <div
        className="session-row-icon"
        style={{
          color,
          backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
          borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
        }}
      >
        <TypeIcon size={17} />
      </div>

      <div className="session-main-cell">
        <div className="session-title-line">
          <span className="session-type-pill" style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}>
            {session.typeLabel}
          </span>
          <span className="session-agent">{session.agentId}</span>
          {session.hasTranscript && <span className="session-soft-pill">JSONL</span>}
          {session.aborted && <span className="session-danger-pill">Abortada</span>}
          {context !== null && context >= 80 && <span className="session-warning-pill">Contexto alto</span>}
        </div>
        <div className="session-title" title={session.title || session.key}>
          {session.title || session.key}
        </div>
        <div className="session-key" title={session.key}>
          {session.key}
        </div>
      </div>

      <div className="session-provider">
        <span>{shortModel(session.model)}</span>
        <small>{SOURCE_LABELS[session.source]}</small>
      </div>

      <div className="session-token-cell">
        <strong>{formatTokens(session.totalTokens)}</strong>
        <span>{formatNumber(session.messageCount)} msgs</span>
      </div>

      <div className="session-context">
        {context === null ? (
          <span className="muted-text">ctx n/d</span>
        ) : (
          <>
            <div className="context-bar">
              <div
                style={{
                  width: `${Math.min(context, 100)}%`,
                  backgroundColor: context >= 80 ? "var(--negative)" : context >= 60 ? "var(--warning)" : "var(--positive)",
                }}
              />
            </div>
            <span>{context}%</span>
          </>
        )}
      </div>

      <div className="session-updated">
        <time title={formatExact(session.updatedAt)}>{formatRelative(session.updatedAt)}</time>
      </div>

      <ChevronRight className="session-chevron" size={16} />
    </button>
  );
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [meta, setMeta] = useState<SessionsMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterType>("all");
  const [sort, setSort] = useState<SortKey>("updated");
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);

  const loadSessions = useCallback(async (silent = false) => {
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      setError(null);
      const res = await fetch(`/api/sessions?ts=${Date.now()}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "Falha ao carregar sessões");
      }

      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
      setMeta({
        total: Number(data.total || 0),
        source: data.source || "unavailable",
        sources: Array.isArray(data.sources) ? data.sources : [],
        generatedAt: Number(data.generatedAt || Date.now()),
        openclawDir: String(data.openclawDir || ""),
        diagnostics: Array.isArray(data.diagnostics) ? data.diagnostics : [],
        error: typeof data.error === "string" ? data.error : null,
      });
      setLastLoadedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar sessões");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => loadSessions(true), 10_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, loadSessions]);

  const counts = useMemo(() => {
    return sessions.reduce<Record<FilterType, number>>(
      (acc, session) => {
        acc.all += 1;
        if (session.type in acc) acc[session.type as FilterType] += 1;
        if (session.hasTranscript) acc.transcript += 1;
        if (isAlertSession(session)) acc.alerts += 1;
        return acc;
      },
      { all: 0, main: 0, cron: 0, subagent: 0, direct: 0, transcript: 0, alerts: 0 }
    );
  }, [sessions]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();

    return sessions
      .filter((session) => {
        if (filter === "transcript" && !session.hasTranscript) return false;
        if (filter === "alerts" && !isAlertSession(session)) return false;
        if (!["all", "transcript", "alerts"].includes(filter) && session.type !== filter) return false;

        if (!q) return true;

        const haystack = [
          session.key,
          session.title,
          session.agentId,
          session.model,
          session.typeLabel,
          session.sessionId || "",
          session.cronJobId || "",
          session.channel || "",
        ].join(" ").toLowerCase();

        return haystack.includes(q);
      })
      .sort((a, b) => {
        if (sort === "tokens") return b.totalTokens - a.totalTokens;
        if (sort === "messages") return b.messageCount - a.messageCount;
        if (sort === "context") return (b.contextUsedPercent ?? -1) - (a.contextUsedPercent ?? -1);
        return b.updatedAt - a.updatedAt;
      });
  }, [filter, search, sessions, sort]);

  const totalTokens = useMemo(
    () => sessions.reduce((sum, session) => sum + session.totalTokens, 0),
    [sessions]
  );
  const activeNow = useMemo(
    () => sessions.filter((session) => Date.now() - session.updatedAt < 15 * 60 * 1000).length,
    [sessions]
  );
  const uniqueModels = useMemo(
    () => new Set(sessions.map((session) => session.model).filter((model) => model && model !== "unknown")).size,
    [sessions]
  );
  const totalMessages = useMemo(
    () => sessions.reduce((sum, session) => sum + session.messageCount, 0),
    [sessions]
  );

  const source = meta?.source || "unavailable";

  return (
    <>
      <main className="sessions-page">
        <header className="sessions-top">
          <div>
            <div className="page-kicker">
              <MessageSquare size={17} />
              Sessões OpenClaw
            </div>
            <h1>Histórico de Sessões</h1>
            <p>Todas as sessões reais encontradas via CLI, status e transcrições JSONL.</p>
          </div>

          <div className="source-panel">
            <span className="source-pill" style={sourceTone(source)}>
              <Radio size={13} />
              {SOURCE_LABELS[source]}
            </span>
            <span>{lastLoadedAt ? `Atualizado ${formatRelative(lastLoadedAt)}` : "Aguardando carga"}</span>
          </div>
        </header>

        <section className="summary-grid">
          <StatCard
            icon={MessageSquare}
            label="Sessões"
            value={formatNumber(sessions.length)}
            detail={`${formatNumber(activeNow)} ativas nos últimos 15 min`}
            color="var(--accent)"
          />
          <StatCard
            icon={Hash}
            label="Tokens"
            value={formatTokens(totalTokens)}
            detail={`${formatNumber(totalMessages)} mensagens indexadas`}
            color="#60a5fa"
          />
          <StatCard
            icon={Database}
            label="Transcrições"
            value={formatNumber(counts.transcript)}
            detail={`${formatNumber(sessions.length - counts.transcript)} sem JSONL local`}
            color="#32d74b"
          />
          <StatCard
            icon={Gauge}
            label="Modelos"
            value={formatNumber(uniqueModels)}
            detail={`${formatNumber(counts.alerts)} sessões pedem atenção`}
            color="#a78bfa"
          />
        </section>

        {(error || meta?.error || (meta?.diagnostics?.length ?? 0) > 0) && (
          <section className={error || meta?.error ? "diagnostic-banner danger" : "diagnostic-banner"}>
            <AlertTriangle size={17} />
            <div>
              <strong>{error || meta?.error || "Diagnóstico da coleta"}</strong>
              {meta?.openclawDir && <p>OPENCLAW_DIR: {meta.openclawDir}</p>}
              {meta?.diagnostics?.slice(0, 3).map((item) => (
                <p key={item}>{item}</p>
              ))}
            </div>
          </section>
        )}

        <section className="sessions-shell">
          <div className="sessions-toolbar">
            <div className="filter-tabs" role="tablist" aria-label="Filtros de sessões">
              {FILTER_TABS.map((tab) => {
                const Icon = tab.icon;
                const active = filter === tab.id;
                const count = counts[tab.id] || 0;

                return (
                  <button
                    key={tab.id}
                    className={active ? "active" : ""}
                    onClick={() => setFilter(tab.id)}
                    role="tab"
                    aria-selected={active}
                  >
                    <Icon size={14} />
                    <span>{tab.label}</span>
                    <small>{formatNumber(count)}</small>
                  </button>
                );
              })}
            </div>

            <div className="toolbar-actions">
              <label className="search-box">
                <Search size={14} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Filtrar sessões..."
                />
              </label>

              <label className="sort-box">
                <ArrowDownUp size={14} />
                <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
                  <option value="updated">Atualização</option>
                  <option value="tokens">Tokens</option>
                  <option value="messages">Mensagens</option>
                  <option value="context">Contexto</option>
                </select>
              </label>

              <button
                className={autoRefresh ? "auto-refresh active" : "auto-refresh"}
                onClick={() => setAutoRefresh((value) => !value)}
                title="Alternar atualização automática"
              >
                <TimerReset size={14} />
                <span>Tempo real</span>
              </button>

              <button
                className="icon-button bordered"
                onClick={() => loadSessions(sessions.length > 0)}
                disabled={loading || refreshing}
                title="Atualizar agora"
                aria-label="Atualizar sessões"
              >
                <RefreshCw className={loading || refreshing ? "spin" : ""} size={16} />
              </button>
            </div>
          </div>

          <div className="session-header-row">
            <span />
            <span>Sessão</span>
            <span className="session-provider">Modelo / fonte</span>
            <span>Tokens</span>
            <span className="session-context">Contexto</span>
            <span className="session-updated">Atualizado</span>
            <span />
          </div>

          {loading && (
            <div className="center-state table-state">
              <RefreshCw className="spin" size={20} />
              Carregando sessões reais...
            </div>
          )}

          {!loading && !error && filtered.length === 0 && (
            <div className="center-state table-state muted">
              <MessageSquare size={36} />
              {sessions.length === 0
                ? "Nenhuma sessão real foi encontrada nas fontes configuradas."
                : "Nenhuma sessão corresponde aos filtros atuais."}
            </div>
          )}

          {!loading && error && (
            <div className="inline-error table-state">
              <AlertTriangle size={17} />
              {error}
            </div>
          )}

          {!loading && !error && filtered.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onClick={() => setSelectedSession(session)}
            />
          ))}
        </section>
      </main>

      {selectedSession && (
        <SessionDetail
          session={selectedSession}
          onClose={() => setSelectedSession(null)}
        />
      )}

      <style jsx global>{`
        .sessions-page {
          min-height: 100vh;
          padding: 28px 32px 40px;
        }

        .sessions-top {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 20px;
          margin-bottom: 22px;
        }

        .page-kicker {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          color: var(--accent);
          font-size: 12px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-bottom: 8px;
        }

        .sessions-top h1 {
          margin: 0 0 6px;
          color: var(--text-primary);
          font-size: 30px;
          font-weight: 750;
          letter-spacing: 0;
        }

        .sessions-top p,
        .source-panel span,
        .session-stat-detail,
        .session-key,
        .session-provider small,
        .muted-text {
          color: var(--text-muted);
        }

        .sessions-top p {
          margin: 0;
          font-size: 14px;
        }

        .source-panel {
          display: flex;
          align-items: flex-end;
          flex-direction: column;
          gap: 8px;
          font-size: 12px;
          white-space: nowrap;
        }

        .source-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 9px;
          border-radius: 8px;
          font-weight: 700;
        }

        .summary-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 12px;
          margin-bottom: 18px;
        }

        .session-stat-card {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
          padding: 16px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--surface);
        }

        .session-stat-icon,
        .session-row-icon,
        .session-drawer-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .session-stat-icon {
          width: 38px;
          height: 38px;
          border-radius: 8px;
        }

        .session-stat-copy {
          min-width: 0;
        }

        .session-stat-value {
          color: var(--text-primary);
          font-size: 22px;
          font-weight: 760;
          line-height: 1.1;
        }

        .session-stat-label {
          margin-top: 2px;
          color: var(--text-secondary);
          font-size: 12px;
          font-weight: 650;
        }

        .session-stat-detail {
          margin-top: 2px;
          font-size: 11px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .diagnostic-banner {
          display: flex;
          gap: 10px;
          align-items: flex-start;
          margin-bottom: 16px;
          padding: 12px 14px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--surface);
          color: var(--warning);
          font-size: 13px;
        }

        .diagnostic-banner.danger {
          color: var(--negative);
          border-color: rgba(255, 69, 58, 0.25);
          background: var(--negative-soft);
        }

        .diagnostic-banner strong {
          display: block;
          color: var(--text-primary);
          margin-bottom: 3px;
        }

        .diagnostic-banner p {
          margin: 2px 0 0;
          color: inherit;
          word-break: break-word;
        }

        .sessions-shell {
          overflow: hidden;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--surface);
        }

        .sessions-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 14px;
          border-bottom: 1px solid var(--border);
        }

        .filter-tabs,
        .toolbar-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }

        .filter-tabs button,
        .auto-refresh,
        .outline-action {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          height: 34px;
          padding: 0 10px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--surface-elevated);
          color: var(--text-secondary);
          font-size: 12px;
          font-weight: 650;
          cursor: pointer;
        }

        .filter-tabs button.active,
        .auto-refresh.active {
          color: var(--accent);
          border-color: rgba(255, 59, 48, 0.35);
          background: var(--accent-soft);
        }

        .filter-tabs small {
          min-width: 18px;
          padding: 1px 6px;
          border-radius: 999px;
          background: rgba(255,255,255,0.06);
          color: inherit;
          font-size: 10px;
        }

        .search-box,
        .sort-box {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          height: 34px;
          padding: 0 10px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--surface-elevated);
          color: var(--text-muted);
        }

        .search-box input,
        .sort-box select {
          border: 0;
          outline: 0;
          background: transparent;
          color: var(--text-primary);
          font-size: 12px;
        }

        .search-box input {
          width: 180px;
        }

        .sort-box select {
          width: 118px;
          cursor: pointer;
        }

        .icon-button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 34px;
          border: 0;
          border-radius: 8px;
          background: transparent;
          color: var(--text-secondary);
          cursor: pointer;
        }

        .icon-button.bordered {
          border: 1px solid var(--border);
          background: var(--surface-elevated);
        }

        .icon-button:hover,
        .filter-tabs button:hover,
        .auto-refresh:hover,
        .outline-action:hover {
          color: var(--text-primary);
          border-color: var(--border-strong);
          background: var(--surface-hover);
        }

        .session-header-row,
        .session-row {
          display: grid;
          grid-template-columns: 40px minmax(280px, 1fr) 128px 104px 100px 112px 18px;
          align-items: center;
          gap: 12px;
          min-width: 860px;
        }

        .session-header-row {
          padding: 9px 14px;
          border-bottom: 1px solid var(--border);
          background: rgba(255,255,255,0.03);
          color: var(--text-muted);
          font-size: 10px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }

        .session-row {
          width: 100%;
          padding: 13px 14px;
          border: 0;
          border-bottom: 1px solid var(--border);
          background: transparent;
          color: inherit;
          text-align: left;
          cursor: pointer;
        }

        .session-row:hover {
          background: var(--surface-elevated);
        }

        .session-row-icon {
          width: 34px;
          height: 34px;
          border: 1px solid;
          border-radius: 8px;
        }

        .session-main-cell {
          min-width: 0;
        }

        .session-title-line,
        .session-badges,
        .drawer-metrics,
        .drawer-actions {
          display: flex;
          align-items: center;
          gap: 7px;
          flex-wrap: wrap;
        }

        .session-type-pill,
        .session-soft-pill,
        .session-danger-pill,
        .session-warning-pill,
        .session-agent,
        .session-badges span {
          display: inline-flex;
          align-items: center;
          height: 20px;
          padding: 0 7px;
          border-radius: 6px;
          font-size: 10px;
          font-weight: 800;
        }

        .session-agent,
        .session-soft-pill,
        .session-badges span {
          color: var(--text-secondary);
          background: rgba(255,255,255,0.06);
        }

        .session-danger-pill,
        .session-badges .danger {
          color: var(--negative);
          background: var(--negative-soft);
        }

        .session-warning-pill {
          color: var(--warning);
          background: var(--warning-soft);
        }

        .session-title {
          margin-top: 5px;
          color: var(--text-primary);
          font-size: 13px;
          font-weight: 700;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .session-key {
          margin-top: 3px;
          font-family: var(--font-mono);
          font-size: 11px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .session-provider,
        .session-token-cell,
        .session-context,
        .session-updated {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 3px;
          min-width: 0;
        }

        .session-provider span,
        .session-token-cell strong,
        .session-updated time {
          color: var(--text-primary);
          font-size: 12px;
          font-weight: 700;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 100%;
        }

        .session-token-cell span,
        .session-context span {
          color: var(--text-muted);
          font-size: 11px;
        }

        .context-bar {
          width: 76px;
          height: 5px;
          border-radius: 999px;
          background: var(--border);
          overflow: hidden;
        }

        .context-bar div {
          height: 100%;
          border-radius: inherit;
        }

        .session-chevron {
          color: var(--text-muted);
        }

        .center-state,
        .inline-error {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 9px;
          color: var(--text-secondary);
          font-size: 13px;
        }

        .table-state {
          min-height: 150px;
          border-bottom: 1px solid var(--border);
        }

        .center-state.muted {
          flex-direction: column;
          color: var(--text-muted);
        }

        .inline-error {
          justify-content: flex-start;
          padding: 16px;
          color: var(--negative);
        }

        .spin {
          animation: session-spin 0.8s linear infinite;
        }

        @keyframes session-spin {
          to { transform: rotate(360deg); }
        }

        .session-drawer-backdrop {
          position: fixed;
          inset: 0;
          z-index: 80;
          display: flex;
          justify-content: flex-end;
          background: rgba(0, 0, 0, 0.56);
          backdrop-filter: blur(3px);
        }

        .session-drawer {
          width: min(720px, 100vw);
          height: 100%;
          display: flex;
          flex-direction: column;
          background: var(--surface);
          border-left: 1px solid var(--border);
          overflow: hidden;
        }

        .session-drawer-header {
          padding: 18px;
          border-bottom: 1px solid var(--border);
        }

        .session-drawer-title-row {
          display: flex;
          align-items: flex-start;
          gap: 12px;
        }

        .session-drawer-icon {
          width: 38px;
          height: 38px;
          border-radius: 8px;
        }

        .session-drawer-title {
          flex: 1;
          min-width: 0;
        }

        .session-drawer-title h2 {
          margin: 8px 0 4px;
          color: var(--text-primary);
          font-size: 18px;
          letter-spacing: 0;
          line-height: 1.25;
        }

        .session-drawer-title p {
          margin: 0;
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 11px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .drawer-actions {
          margin-top: 14px;
        }

        .outline-action:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .drawer-metrics {
          margin-top: 14px;
          color: var(--text-secondary);
          font-size: 12px;
        }

        .drawer-metrics span {
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }

        .drawer-message-summary {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
          padding: 10px 18px;
          border-bottom: 1px solid var(--border);
          background: rgba(255,255,255,0.03);
          color: var(--text-secondary);
          font-size: 12px;
        }

        .drawer-messages {
          flex: 1;
          overflow-y: auto;
          padding: 18px;
        }

        .message-line {
          display: flex;
          gap: 10px;
          margin-bottom: 14px;
        }

        .message-line.user {
          flex-direction: row-reverse;
        }

        .message-avatar {
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          border-radius: 999px;
          background: var(--surface-elevated);
          color: var(--accent);
        }

        .message-line.user .message-avatar {
          color: var(--bg);
          background: var(--accent);
        }

        .message-body {
          width: min(82%, 560px);
        }

        .message-meta {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          margin: 0 4px 5px;
          color: var(--text-muted);
          font-size: 10px;
        }

        .message-bubble {
          padding: 10px 12px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--surface-elevated);
          color: var(--text-primary);
          font-size: 13px;
          line-height: 1.55;
          white-space: pre-wrap;
          word-break: break-word;
        }

        .message-line.user .message-bubble {
          border-color: rgba(255, 59, 48, 0.28);
          background: var(--accent-soft);
        }

        .message-tool,
        .message-result,
        .message-system {
          margin-bottom: 10px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: rgba(255,255,255,0.03);
        }

        .message-tool,
        .message-system {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 9px 11px;
          color: #60a5fa;
          font-size: 12px;
        }

        .message-tool code {
          color: var(--text-secondary);
          white-space: pre-wrap;
          word-break: break-word;
        }

        .message-tool-name {
          color: #60a5fa;
          font-weight: 800;
        }

        .message-result {
          padding: 9px 11px;
          color: var(--positive);
          font-size: 12px;
        }

        .message-result span {
          display: block;
          margin-bottom: 6px;
          font-weight: 800;
        }

        .message-result pre {
          max-height: 160px;
          margin: 0;
          overflow: auto;
          color: var(--text-secondary);
          white-space: pre-wrap;
          word-break: break-word;
        }

        .message-system {
          color: var(--text-secondary);
        }

        @media (max-width: 1180px) {
          .summary-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .sessions-toolbar {
            align-items: stretch;
            flex-direction: column;
          }

          .toolbar-actions {
            justify-content: flex-start;
          }
        }

        @media (max-width: 760px) {
          .sessions-page {
            padding: 18px 14px 28px;
          }

          .sessions-top {
            flex-direction: column;
          }

          .source-panel {
            align-items: flex-start;
          }

          .summary-grid {
            grid-template-columns: 1fr;
          }

          .search-box input {
            width: min(48vw, 180px);
          }

          .session-header-row,
          .session-row {
            grid-template-columns: 38px minmax(0, 1fr) 84px;
            min-width: 0;
          }

          .session-header-row .session-provider,
          .session-header-row .session-context,
          .session-header-row .session-updated,
          .session-header-row span:nth-child(7),
          .session-row .session-provider,
          .session-row .session-context,
          .session-row .session-updated,
          .session-row .session-chevron {
            display: none;
          }

          .session-token-cell {
            align-items: flex-end;
          }

          .session-drawer-header,
          .drawer-messages {
            padding: 14px;
          }
        }
      `}</style>
    </>
  );
}
