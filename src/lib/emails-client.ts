/**
 * Browser-side helpers + types for talking to /api/integrations/email/*.
 *
 * Mirrors the data shape the OpenClaw gateway is expected to expose. The
 * UI imports these types so a future schema tweak only needs editing here.
 */

export interface EmailAccount {
  id: string;
  /** Display label — defaults to the email address if unset. */
  name?: string;
  emailAddress: string;
  /** "configured" | "error" | "not_configured" — surfaced by the gateway test. */
  status: "configured" | "error" | "not_configured" | string;
  /** Last successful IMAP sync (ISO). */
  lastSyncAt?: string | null;
  /** Last error message if any. */
  lastError?: string | null;
  unreadCount?: number;
  /** Server-side hint flags (e.g. SMTP misconfigured even though IMAP works). */
  issues?: string[];
  imap?: { host: string; port: number; tls: boolean; user: string };
  smtp?: { host: string; port: number; tls: boolean; user: string };
}

export interface EmailFolder {
  /** Mailbox path, e.g. "INBOX", "[Gmail]/Spam". */
  path: string;
  /** Display name. */
  name: string;
  /** Standard role hint: inbox, sent, drafts, trash, junk, archive, other. */
  role?: string;
  unreadCount?: number;
  totalCount?: number;
}

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface EmailEnvelope {
  accountId: string;
  uid: string;
  folder: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc?: EmailAddress[];
  subject: string;
  snippet: string;
  date: string;
  seen: boolean;
  flagged: boolean;
  answered?: boolean;
  hasAttachments: boolean;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface EmailMessage extends EmailEnvelope {
  bodyText?: string;
  bodyHtml?: string;
  attachments?: Array<{
    filename: string;
    contentType: string;
    size: number;
    contentId?: string;
  }>;
  headers?: Record<string, string>;
}

export interface MessagesPage {
  messages: EmailEnvelope[];
  total: number;
  page: number;
  limit: number;
}

export interface AccountInput {
  id: string;
  name?: string;
  emailAddress: string;
  imap: { host: string; port: number; tls: boolean; user: string; password: string };
  smtp: { host: string; port: number; tls: boolean; user: string; password: string };
}

export interface SendInput {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface MessageListFilters {
  accounts?: string[];
  folder?: string;
  q?: string;
  unread?: boolean;
  page?: number;
  limit?: number;
}

interface ApiError {
  error: string;
  code?: string;
  hint?: string;
}

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, { cache: "no-store", ...init });
  let json: T | ApiError | null = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text) as T | ApiError;
    } catch {
      throw new Error(text.slice(0, 200) || `HTTP ${res.status}`);
    }
  }
  if (!res.ok) {
    const err = json as ApiError | null;
    const msg = err?.error || `HTTP ${res.status}`;
    const error = new Error(err?.hint ? `${msg} — ${err.hint}` : msg);
    (error as Error & { code?: string }).code = err?.code;
    throw error;
  }
  return json as T;
}

export const emailsClient = {
  listAccounts: () => request<EmailAccount[]>("/api/integrations/email/accounts"),

  addAccount: (input: AccountInput) =>
    request<EmailAccount>("/api/integrations/email/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),

  deleteAccount: (id: string) =>
    request<{ ok: true }>(`/api/integrations/email/accounts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  testAccount: (id: string, override?: Partial<AccountInput>) =>
    request<{ ok: boolean; imap?: { ok: boolean; error?: string }; smtp?: { ok: boolean; error?: string } }>(
      `/api/integrations/email/accounts/${encodeURIComponent(id)}?action=test`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(override ?? {}),
      },
    ),

  patchAccount: (id: string, patch: Partial<AccountInput>) =>
    request<EmailAccount>(`/api/integrations/email/accounts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),

  listFolders: (accountId: string) =>
    request<EmailFolder[]>(
      `/api/integrations/email/folders?account=${encodeURIComponent(accountId)}`,
    ),

  listMessages: (filters: MessageListFilters) => {
    const qs = new URLSearchParams();
    if (filters.accounts && filters.accounts.length) qs.set("accounts", filters.accounts.join(","));
    if (filters.folder) qs.set("folder", filters.folder);
    if (filters.q) qs.set("q", filters.q);
    if (filters.unread) qs.set("unread", "1");
    if (filters.page) qs.set("page", String(filters.page));
    if (filters.limit) qs.set("limit", String(filters.limit));
    return request<MessagesPage>(
      `/api/integrations/email/messages${qs.toString() ? `?${qs.toString()}` : ""}`,
    );
  },

  getMessage: (accountId: string, uid: string, folder?: string) => {
    const qs = folder ? `?folder=${encodeURIComponent(folder)}` : "";
    return request<EmailMessage>(
      `/api/integrations/email/messages/${encodeURIComponent(accountId)}/${encodeURIComponent(uid)}${qs}`,
    );
  },

  setFlags: (
    accountId: string,
    uid: string,
    flags: { seen?: boolean; flagged?: boolean; folder?: string },
  ) =>
    request<{ ok: true }>(
      `/api/integrations/email/messages/${encodeURIComponent(accountId)}/${encodeURIComponent(uid)}/flags`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(flags),
      },
    ),

  moveMessage: (
    accountId: string,
    uid: string,
    payload: { folder: string; sourceFolder?: string },
  ) =>
    request<{ ok: true }>(
      `/api/integrations/email/messages/${encodeURIComponent(accountId)}/${encodeURIComponent(uid)}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    ),

  send: (input: SendInput) =>
    request<{ ok: true; messageId?: string }>(`/api/integrations/email/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
};

export function formatAddress(a: EmailAddress | undefined): string {
  if (!a) return "";
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export function formatAddressList(list: EmailAddress[] | undefined): string {
  if (!list || list.length === 0) return "";
  return list.map(formatAddress).join(", ");
}
