"use client";

/**
 * Unified inbox across all connected IMAP accounts.
 *
 * Three-pane layout (mobile collapses):
 *   - Left:   account/folder sidebar with "All accounts" mode
 *   - Center: envelope list (subject, from, snippet, date, account badge)
 *   - Right:  selected message body + reply/forward/move/archive
 *
 * Everything is live via gateway — no AtlasDeck-side cache. List & body
 * are re-fetched on every interaction so the inbox always matches what
 * the IMAP server holds.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Mail,
  RefreshCw,
  Search,
  Filter,
  Inbox,
  Send,
  Trash2,
  Archive,
  Reply,
  ReplyAll,
  Forward,
  Paperclip,
  Star,
  CheckCircle2,
  XCircle,
  Loader2,
  Settings as SettingsIcon,
  Plus,
  AlertTriangle,
  Mailbox,
  Eye,
  EyeOff,
  Folder as FolderIcon,
} from "lucide-react";
import {
  emailsClient,
  formatAddress,
  formatAddressList,
  type EmailAccount,
  type EmailEnvelope,
  type EmailFolder,
  type EmailMessage,
} from "@/lib/emails-client";
import { ImapSetupModal } from "@/components/emails/ImapSetupModal";
import { EmailComposer } from "@/components/emails/EmailComposer";

interface FoldersByAccount {
  [accountId: string]: EmailFolder[];
}

const PAGE_LIMIT = 50;

export default function EmailsPage() {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [foldersByAccount, setFoldersByAccount] = useState<FoldersByAccount>({});
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string>("INBOX");
  const [envelopes, setEnvelopes] = useState<EmailEnvelope[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [message, setMessage] = useState<EmailMessage | null>(null);

  const [listLoading, setListLoading] = useState(false);
  const [messageLoading, setMessageLoading] = useState(false);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);

  const [setupOpen, setSetupOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerMode, setComposerMode] = useState<"new" | "reply" | "reply-all" | "forward">("new");
  const [showHtml, setShowHtml] = useState(false);

  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Accounts + folders ───────────────────────────────────────
  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const list = await emailsClient.listAccounts();
      setAccounts(list);
      if (selectedAccounts.length === 0 && list.length > 0) {
        setSelectedAccounts(list.map((a) => a.id));
      }
    } catch (e) {
      setAccountsError(e instanceof Error ? e.message : String(e));
    } finally {
      setAccountsLoading(false);
    }
  }, [selectedAccounts.length]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  // Lazy-load folders per account
  useEffect(() => {
    accounts.forEach(async (a) => {
      if (foldersByAccount[a.id]) return;
      try {
        const list = await emailsClient.listFolders(a.id);
        setFoldersByAccount((cur) => ({ ...cur, [a.id]: list }));
      } catch {
        // surface error softly per account; main inbox still works
      }
    });
  }, [accounts, foldersByAccount]);

  // ─── Envelope list ────────────────────────────────────────────
  const loadList = useCallback(async () => {
    if (selectedAccounts.length === 0) {
      setEnvelopes([]);
      setTotal(0);
      return;
    }
    setListLoading(true);
    setError(null);
    try {
      const res = await emailsClient.listMessages({
        accounts: selectedAccounts,
        folder: selectedFolder,
        q: search.trim() || undefined,
        unread: onlyUnread || undefined,
        page,
        limit: PAGE_LIMIT,
      });
      setEnvelopes(res.messages);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEnvelopes([]);
      setTotal(0);
    } finally {
      setListLoading(false);
    }
  }, [selectedAccounts, selectedFolder, search, onlyUnread, page]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Debounced search
  const onSearchChange = (v: string) => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      setSearch(v);
      setPage(1);
    }, 350);
  };

  // ─── Selected message ────────────────────────────────────────
  const onSelectEnvelope = async (env: EmailEnvelope) => {
    const key = `${env.accountId}:${env.uid}`;
    setSelectedKey(key);
    setMessage(null);
    setMessageLoading(true);
    setShowHtml(false);
    try {
      const full = await emailsClient.getMessage(env.accountId, env.uid, env.folder);
      setMessage(full);
      // Auto-mark as read if not already
      if (!env.seen) {
        try {
          await emailsClient.setFlags(env.accountId, env.uid, { seen: true, folder: env.folder });
          setEnvelopes((cur) =>
            cur.map((e) =>
              e.accountId === env.accountId && e.uid === env.uid ? { ...e, seen: true } : e,
            ),
          );
        } catch {
          // non-fatal
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMessageLoading(false);
    }
  };

  const toggleFlag = async (envelope: EmailEnvelope, flag: "seen" | "flagged") => {
    const next = flag === "seen" ? !envelope.seen : !envelope.flagged;
    try {
      await emailsClient.setFlags(envelope.accountId, envelope.uid, {
        [flag]: next,
        folder: envelope.folder,
      });
      setEnvelopes((cur) =>
        cur.map((e) =>
          e.accountId === envelope.accountId && e.uid === envelope.uid
            ? { ...e, [flag]: next }
            : e,
        ),
      );
      if (message && message.accountId === envelope.accountId && message.uid === envelope.uid) {
        setMessage({ ...message, [flag]: next });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const archiveMessage = async (envelope: EmailEnvelope) => {
    const folders = foldersByAccount[envelope.accountId] ?? [];
    const archive = folders.find((f) => f.role === "archive") ??
      folders.find((f) => /archive|arquivo|all mail/i.test(f.name));
    if (!archive) {
      setError("Pasta de arquivo não encontrada para esta conta. Configure uma pasta com role=archive ou mova manualmente.");
      return;
    }
    try {
      await emailsClient.moveMessage(envelope.accountId, envelope.uid, {
        folder: archive.path,
        sourceFolder: envelope.folder,
      });
      setEnvelopes((cur) => cur.filter((e) => !(e.accountId === envelope.accountId && e.uid === envelope.uid)));
      if (selectedKey === `${envelope.accountId}:${envelope.uid}`) {
        setMessage(null);
        setSelectedKey(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteMessage = async (envelope: EmailEnvelope) => {
    const folders = foldersByAccount[envelope.accountId] ?? [];
    const trash = folders.find((f) => f.role === "trash") ??
      folders.find((f) => /trash|lixeira|deleted/i.test(f.name));
    if (!trash) {
      setError("Pasta de lixeira não encontrada para esta conta.");
      return;
    }
    if (!confirm("Mover para lixeira?")) return;
    try {
      await emailsClient.moveMessage(envelope.accountId, envelope.uid, {
        folder: trash.path,
        sourceFolder: envelope.folder,
      });
      setEnvelopes((cur) => cur.filter((e) => !(e.accountId === envelope.accountId && e.uid === envelope.uid)));
      if (selectedKey === `${envelope.accountId}:${envelope.uid}`) {
        setMessage(null);
        setSelectedKey(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // ─── Derived metrics ─────────────────────────────────────────
  const totalUnread = useMemo(
    () => accounts.reduce((sum, a) => sum + (a.unreadCount ?? 0), 0),
    [accounts],
  );

  const hasGatewayError = accountsError?.includes("GATEWAY_ROUTE_MISSING") || accountsError?.includes("não expõe");

  // ─── Render ──────────────────────────────────────────────────
  if (accountsLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: "var(--accent)" }} />
      </div>
    );
  }

  return (
    <div style={{ padding: "16px 24px 24px", maxWidth: 1600, marginInline: "auto" }}>
      {/* Header + KPI cards */}
      <div className="flex flex-col gap-4 mb-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <Mail className="w-6 h-6" style={{ color: "var(--accent)" }} />
            <h1
              className="text-2xl font-bold"
              style={{
                fontFamily: "var(--font-heading)",
                color: "var(--text-primary)",
                letterSpacing: "-0.5px",
              }}
            >
              E-mails
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setComposerMode("new");
                setComposerOpen(true);
              }}
              disabled={accounts.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg disabled:opacity-50"
              style={{
                backgroundColor: "rgba(139,92,246,0.2)",
                color: "#c4b5fd",
                border: "1px solid rgba(139,92,246,0.4)",
              }}
            >
              <Plus className="w-4 h-4" /> Compor
            </button>
            <Link
              href="/emails/settings"
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg"
              style={{
                backgroundColor: "rgba(255,255,255,0.04)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border)",
              }}
            >
              <SettingsIcon className="w-4 h-4" /> Contas
            </Link>
            <button
              onClick={() => void loadList()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg"
              style={{
                backgroundColor: "rgba(255,255,255,0.04)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border)",
              }}
            >
              <RefreshCw className={`w-4 h-4 ${listLoading ? "animate-spin" : ""}`} /> Atualizar
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi icon={Mailbox} label="Contas conectadas" value={`${accounts.length}`} />
          <Kpi icon={Inbox} label="Não lidos" value={`${totalUnread}`} />
          <Kpi icon={Filter} label="Filtro ativo" value={selectedFolder} />
          <Kpi icon={Send} label="Mensagens (pág.)" value={`${envelopes.length}/${total}`} />
        </div>
      </div>

      {accountsError && (
        <div
          className="rounded-lg p-3 text-sm mb-4 flex items-start gap-2"
          style={{
            backgroundColor: "rgba(234,179,8,0.08)",
            color: "#fde047",
            border: "1px solid rgba(234,179,8,0.3)",
          }}
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Gateway OpenClaw não respondeu</div>
            <div className="text-xs mt-1" style={{ color: "var(--text-secondary)" }}>
              {accountsError}
              {hasGatewayError && (
                <>
                  {" "}
                  A skill IMAP existe no workspace, mas o daemon precisa expor as rotas HTTP. Veja o
                  contrato em <code>src/lib/email-gateway.ts</code>.
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {accounts.length === 0 && !accountsError && (
        <EmptyState onAdd={() => setSetupOpen(true)} />
      )}

      {accounts.length > 0 && (
        <div
          className="rounded-xl overflow-hidden"
          style={{ border: "1px solid var(--border)", backgroundColor: "var(--card)" }}
        >
          <div className="grid grid-cols-1 lg:grid-cols-12" style={{ minHeight: 600 }}>
            {/* Sidebar */}
            <aside
              className="lg:col-span-3 border-b lg:border-b-0 lg:border-r p-3 overflow-auto"
              style={{ borderColor: "var(--border)", maxHeight: 720 }}
            >
              <div className="text-xs uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>
                Contas
              </div>
              <div className="space-y-1 mb-3">
                <button
                  onClick={() => setSelectedAccounts(accounts.map((a) => a.id))}
                  className="w-full text-left text-xs px-2 py-1.5 rounded flex items-center justify-between"
                  style={{
                    backgroundColor:
                      selectedAccounts.length === accounts.length
                        ? "rgba(139,92,246,0.15)"
                        : "transparent",
                    color: "var(--text-primary)",
                  }}
                >
                  <span>Todas as contas</span>
                  <span style={{ color: "var(--text-muted)" }}>{accounts.length}</span>
                </button>
                {accounts.map((a) => {
                  const checked = selectedAccounts.includes(a.id);
                  return (
                    <label
                      key={a.id}
                      className="flex items-center justify-between gap-2 text-xs px-2 py-1.5 rounded cursor-pointer"
                      style={{
                        backgroundColor: checked ? "rgba(139,92,246,0.08)" : "transparent",
                      }}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            setSelectedAccounts((cur) =>
                              e.target.checked
                                ? Array.from(new Set([...cur, a.id]))
                                : cur.filter((id) => id !== a.id),
                            );
                            setPage(1);
                          }}
                        />
                        <span className="truncate" style={{ color: "var(--text-primary)" }}>
                          {a.name || a.emailAddress}
                        </span>
                      </span>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          backgroundColor:
                            a.status === "error"
                              ? "rgba(239,68,68,0.15)"
                              : a.status === "configured"
                                ? "rgba(16,185,129,0.15)"
                                : "rgba(234,179,8,0.15)",
                          color:
                            a.status === "error"
                              ? "#fca5a5"
                              : a.status === "configured"
                                ? "#6ee7b7"
                                : "#fde047",
                        }}
                      >
                        {a.unreadCount ?? 0}
                      </span>
                    </label>
                  );
                })}
              </div>

              <div
                className="text-xs uppercase tracking-wider mb-2 mt-3"
                style={{ color: "var(--text-muted)" }}
              >
                Pastas
              </div>
              <div className="space-y-0.5">
                {STANDARD_FOLDERS.map((folder) => (
                  <button
                    key={folder.path}
                    onClick={() => {
                      setSelectedFolder(folder.path);
                      setPage(1);
                    }}
                    className="w-full text-left text-xs px-2 py-1.5 rounded flex items-center gap-2"
                    style={{
                      backgroundColor:
                        selectedFolder === folder.path
                          ? "rgba(139,92,246,0.15)"
                          : "transparent",
                      color: "var(--text-primary)",
                    }}
                  >
                    <folder.icon className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} />
                    {folder.label}
                  </button>
                ))}
              </div>
            </aside>

            {/* List */}
            <section
              className="lg:col-span-4 border-b lg:border-b-0 lg:border-r flex flex-col"
              style={{ borderColor: "var(--border)", maxHeight: 720 }}
            >
              <div
                className="p-3 border-b flex items-center gap-2"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="flex-1 relative">
                  <Search
                    className="w-3.5 h-3.5 absolute left-2 top-2.5"
                    style={{ color: "var(--text-muted)" }}
                  />
                  <input
                    placeholder="Buscar…"
                    onChange={(e) => onSearchChange(e.target.value)}
                    className="w-full rounded pl-7 pr-2 py-1.5 text-xs"
                    style={{
                      backgroundColor: "rgba(0,0,0,0.3)",
                      border: "1px solid var(--border)",
                      color: "var(--text-primary)",
                    }}
                  />
                </div>
                <button
                  onClick={() => {
                    setOnlyUnread((v) => !v);
                    setPage(1);
                  }}
                  className="text-xs px-2 py-1.5 rounded"
                  style={{
                    backgroundColor: onlyUnread ? "rgba(139,92,246,0.2)" : "rgba(255,255,255,0.04)",
                    color: onlyUnread ? "#c4b5fd" : "var(--text-secondary)",
                    border: `1px solid ${onlyUnread ? "rgba(139,92,246,0.4)" : "var(--border)"}`,
                  }}
                  title="Mostrar apenas não lidos"
                >
                  Não lidos
                </button>
              </div>

              <div className="overflow-auto flex-1">
                {listLoading && envelopes.length === 0 && (
                  <div
                    className="p-6 flex items-center justify-center gap-2 text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
                  </div>
                )}
                {!listLoading && envelopes.length === 0 && !error && (
                  <div
                    className="p-6 text-center text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Nenhuma mensagem.
                  </div>
                )}
                {envelopes.map((env) => {
                  const key = `${env.accountId}:${env.uid}`;
                  const isSelected = key === selectedKey;
                  const acct = accounts.find((a) => a.id === env.accountId);
                  return (
                    <button
                      key={key}
                      onClick={() => onSelectEnvelope(env)}
                      className="w-full text-left p-3 border-b text-xs"
                      style={{
                        backgroundColor: isSelected
                          ? "rgba(139,92,246,0.1)"
                          : env.seen
                            ? "transparent"
                            : "rgba(139,92,246,0.04)",
                        borderColor: "var(--border)",
                      }}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        {!env.seen && (
                          <span
                            className="inline-block w-1.5 h-1.5 rounded-full"
                            style={{ backgroundColor: "var(--accent)" }}
                          />
                        )}
                        <span
                          className="font-medium truncate flex-1"
                          style={{ color: "var(--text-primary)" }}
                        >
                          {formatAddress(env.from[0]) || "(sem remetente)"}
                        </span>
                        {env.hasAttachments && (
                          <Paperclip className="w-3 h-3" style={{ color: "var(--text-muted)" }} />
                        )}
                        {env.flagged && (
                          <Star className="w-3 h-3 text-yellow-400" fill="currentColor" />
                        )}
                        <span className="text-[10px] shrink-0" style={{ color: "var(--text-muted)" }}>
                          {formatRelativeDate(env.date)}
                        </span>
                      </div>
                      <div
                        className="truncate font-medium mb-0.5"
                        style={{
                          color: env.seen ? "var(--text-secondary)" : "var(--text-primary)",
                        }}
                      >
                        {env.subject || "(sem assunto)"}
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                          style={{
                            backgroundColor: "rgba(255,255,255,0.05)",
                            color: "var(--text-muted)",
                          }}
                        >
                          {acct?.name || acct?.emailAddress || env.accountId}
                        </span>
                        <span
                          className="truncate text-[11px]"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {env.snippet}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Pagination */}
              {total > PAGE_LIMIT && (
                <div
                  className="p-2 flex items-center justify-between text-xs border-t"
                  style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
                >
                  <span>
                    {(page - 1) * PAGE_LIMIT + 1}–{Math.min(page * PAGE_LIMIT, total)} de {total}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      className="px-2 py-1 rounded disabled:opacity-40"
                      style={{
                        backgroundColor: "rgba(255,255,255,0.04)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      ←
                    </button>
                    <button
                      disabled={page * PAGE_LIMIT >= total}
                      onClick={() => setPage((p) => p + 1)}
                      className="px-2 py-1 rounded disabled:opacity-40"
                      style={{
                        backgroundColor: "rgba(255,255,255,0.04)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      →
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* Message viewer */}
            <section
              className="lg:col-span-5 p-4 overflow-auto"
              style={{ maxHeight: 720 }}
            >
              {!selectedKey && !messageLoading && (
                <div
                  className="h-full flex items-center justify-center text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  Selecione uma mensagem para visualizar
                </div>
              )}
              {messageLoading && (
                <div
                  className="h-full flex items-center justify-center gap-2 text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  <Loader2 className="w-4 h-4 animate-spin" /> Carregando mensagem…
                </div>
              )}
              {message && (
                <article className="space-y-3">
                  <header className="space-y-2">
                    <h2
                      className="text-lg font-semibold"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {message.subject || "(sem assunto)"}
                    </h2>
                    <div className="text-xs space-y-1" style={{ color: "var(--text-secondary)" }}>
                      <div>
                        <strong>De:</strong> {formatAddressList(message.from)}
                      </div>
                      <div>
                        <strong>Para:</strong> {formatAddressList(message.to)}
                      </div>
                      {message.cc && message.cc.length > 0 && (
                        <div>
                          <strong>Cc:</strong> {formatAddressList(message.cc)}
                        </div>
                      )}
                      <div>
                        <strong>Data:</strong> {new Date(message.date).toLocaleString("pt-BR")}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 pt-2">
                      <ActionBtn icon={Reply} label="Responder" onClick={() => { setComposerMode("reply"); setComposerOpen(true); }} />
                      <ActionBtn icon={ReplyAll} label="Resp. todos" onClick={() => { setComposerMode("reply-all"); setComposerOpen(true); }} />
                      <ActionBtn icon={Forward} label="Encaminhar" onClick={() => { setComposerMode("forward"); setComposerOpen(true); }} />
                      <ActionBtn
                        icon={message.seen ? EyeOff : Eye}
                        label={message.seen ? "Não lido" : "Lido"}
                        onClick={() => {
                          const env = envelopes.find((e) => e.accountId === message.accountId && e.uid === message.uid);
                          if (env) void toggleFlag(env, "seen");
                        }}
                      />
                      <ActionBtn
                        icon={Star}
                        label={message.flagged ? "Desfavoritar" : "Favoritar"}
                        active={message.flagged}
                        onClick={() => {
                          const env = envelopes.find((e) => e.accountId === message.accountId && e.uid === message.uid);
                          if (env) void toggleFlag(env, "flagged");
                        }}
                      />
                      <ActionBtn
                        icon={Archive}
                        label="Arquivar"
                        onClick={() => {
                          const env = envelopes.find((e) => e.accountId === message.accountId && e.uid === message.uid);
                          if (env) void archiveMessage(env);
                        }}
                      />
                      <ActionBtn
                        icon={Trash2}
                        label="Lixeira"
                        danger
                        onClick={() => {
                          const env = envelopes.find((e) => e.accountId === message.accountId && e.uid === message.uid);
                          if (env) void deleteMessage(env);
                        }}
                      />
                    </div>
                  </header>

                  {message.attachments && message.attachments.length > 0 && (
                    <div
                      className="rounded p-2 text-xs space-y-1"
                      style={{
                        backgroundColor: "rgba(0,0,0,0.25)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      <div className="font-medium" style={{ color: "var(--text-secondary)" }}>
                        Anexos
                      </div>
                      {message.attachments.map((att, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <Paperclip className="w-3 h-3" style={{ color: "var(--text-muted)" }} />
                          <span style={{ color: "var(--text-primary)" }}>{att.filename}</span>
                          <span style={{ color: "var(--text-muted)" }}>
                            ({(att.size / 1024).toFixed(1)} KB)
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div
                    className="rounded p-3 text-sm"
                    style={{
                      backgroundColor: "rgba(0,0,0,0.2)",
                      border: "1px solid var(--border)",
                      color: "var(--text-primary)",
                    }}
                  >
                    {message.bodyHtml && showHtml ? (
                      <iframe
                        sandbox=""
                        srcDoc={message.bodyHtml}
                        style={{ width: "100%", minHeight: 400, border: "none", backgroundColor: "#fff" }}
                        title="Conteúdo HTML do e-mail (sandbox)"
                      />
                    ) : (
                      <pre
                        className="whitespace-pre-wrap font-sans text-[13px]"
                        style={{ fontFamily: "inherit" }}
                      >
                        {message.bodyText || (message.bodyHtml ? "[mensagem em HTML — clique em 'Ver HTML']" : "")}
                      </pre>
                    )}
                    {message.bodyHtml && (
                      <button
                        onClick={() => setShowHtml((v) => !v)}
                        className="mt-3 text-xs px-2 py-1 rounded"
                        style={{
                          backgroundColor: "rgba(255,255,255,0.04)",
                          color: "var(--text-secondary)",
                          border: "1px solid var(--border)",
                        }}
                      >
                        {showHtml ? "Ver texto" : "Ver HTML (sandbox)"}
                      </button>
                    )}
                  </div>
                </article>
              )}
            </section>
          </div>

          {error && (
            <div
              className="px-3 py-2 text-xs border-t flex items-center gap-2"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "rgba(239,68,68,0.08)",
                color: "#fca5a5",
              }}
            >
              <XCircle className="w-3.5 h-3.5" />
              {error}
            </div>
          )}
        </div>
      )}

      <ImapSetupModal
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        onSaved={() => {
          void loadAccounts();
          void loadList();
        }}
      />

      <EmailComposer
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        accounts={accounts}
        defaultAccountId={selectedAccounts[0]}
        mode={composerMode}
        replyTo={composerMode === "new" ? null : message}
        onSent={() => void loadList()}
      />
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────

const STANDARD_FOLDERS: Array<{ path: string; label: string; icon: typeof Inbox }> = [
  { path: "INBOX", label: "Caixa de Entrada", icon: Inbox },
  { path: "[Gmail]/Important", label: "Importantes", icon: Star },
  { path: "Sent", label: "Enviados", icon: Send },
  { path: "Drafts", label: "Rascunhos", icon: FolderIcon },
  { path: "Archive", label: "Arquivo", icon: Archive },
  { path: "Trash", label: "Lixeira", icon: Trash2 },
];

function formatRelativeDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diff < day && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  if (diff < 7 * day) {
    return d.toLocaleDateString("pt-BR", { weekday: "short" });
  }
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function Kpi({ icon: Icon, label, value }: { icon: typeof Mail; label: string; value: string }) {
  return (
    <div
      className="rounded-lg p-3 flex items-center gap-3"
      style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
    >
      <div
        className="p-2 rounded-lg"
        style={{ backgroundColor: "rgba(139,92,246,0.1)" }}
      >
        <Icon className="w-4 h-4" style={{ color: "var(--accent)" }} />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          {label}
        </div>
        <div className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>
          {value}
        </div>
      </div>
    </div>
  );
}

function ActionBtn({
  icon: Icon,
  label,
  onClick,
  danger,
  active,
}: {
  icon: typeof Mail;
  label: string;
  onClick: () => void;
  danger?: boolean;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 text-[11px] px-2 py-1 rounded"
      style={{
        backgroundColor: danger
          ? "rgba(239,68,68,0.08)"
          : active
            ? "rgba(234,179,8,0.15)"
            : "rgba(255,255,255,0.04)",
        color: danger ? "#fca5a5" : active ? "#fde047" : "var(--text-secondary)",
        border: `1px solid ${danger ? "rgba(239,68,68,0.3)" : active ? "rgba(234,179,8,0.3)" : "var(--border)"}`,
      }}
    >
      <Icon className="w-3 h-3" />
      {label}
    </button>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div
      className="rounded-xl p-10 text-center"
      style={{ backgroundColor: "var(--card)", border: "1px dashed var(--border)" }}
    >
      <Mail className="w-10 h-10 mx-auto mb-3" style={{ color: "var(--text-muted)" }} />
      <h3 className="text-lg font-medium mb-1" style={{ color: "var(--text-primary)" }}>
        Nenhuma conta conectada
      </h3>
      <p className="text-sm mb-4" style={{ color: "var(--text-secondary)" }}>
        Conecte sua primeira conta IMAP para começar. O OpenClaw guarda as credenciais e mantém a sincronização —
        AtlasDeck só renderiza.
      </p>
      <div className="flex items-center justify-center gap-2">
        <button
          onClick={onAdd}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg"
          style={{
            backgroundColor: "rgba(139,92,246,0.2)",
            color: "#c4b5fd",
            border: "1px solid rgba(139,92,246,0.4)",
          }}
        >
          <Plus className="w-4 h-4" /> Conectar conta
        </button>
      </div>
    </div>
  );
}
