/**
 * IMAP helpers — opens short-lived connections per request, no pooling.
 *
 * Every API route opens a fresh ImapFlow connection, performs its op, and
 * closes. This keeps the architecture stateless (no in-memory cache) and
 * means a stale connection from a server restart cannot poison a request.
 * IMAP servers handle this load fine for interactive UI use.
 */
import { ImapFlow, type FetchMessageObject, type MailboxObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { StoredAccount } from "./email-store";
import { getAccount, markAccountStatus } from "./email-store";

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface EmailFolder {
  path: string;
  name: string;
  role?: string;
  unreadCount?: number;
  totalCount?: number;
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

function connectClient(account: StoredAccount): ImapFlow {
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.tls,
    auth: { user: account.imap.user, pass: account.imap.password },
    logger: false,
    socketTimeout: 30_000,
  });
}

async function withClient<T>(account: StoredAccount, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const client = connectClient(account);
  try {
    await client.connect();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markAccountStatus(account.id, "error", msg);
    throw new Error(`IMAP connect failed: ${msg}`);
  }
  try {
    const out = await fn(client);
    markAccountStatus(account.id, "configured", null);
    return out;
  } finally {
    try {
      await client.logout();
    } catch {
      // swallow logout errors — best effort
    }
  }
}

/**
 * Tests IMAP login only — returns { ok, error? }. Does not throw.
 */
export async function testImapConnection(account: StoredAccount): Promise<{ ok: boolean; error?: string }> {
  const client = connectClient(account);
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Infer a standard role from a mailbox's special-use flag, name, or path.
 * Roles help the UI decide which icon to draw and where "trash" / "archive"
 * actions should move things.
 */
function inferRole(box: { specialUse?: string | null; path: string; name?: string }): string {
  const su = box.specialUse?.toLowerCase();
  if (su === "\\inbox") return "inbox";
  if (su === "\\sent") return "sent";
  if (su === "\\drafts") return "drafts";
  if (su === "\\trash") return "trash";
  if (su === "\\junk") return "junk";
  if (su === "\\archive") return "archive";
  const low = `${box.path} ${box.name ?? ""}`.toLowerCase();
  if (low === "inbox" || low.endsWith("/inbox")) return "inbox";
  if (low.includes("sent") || low.includes("enviado")) return "sent";
  if (low.includes("draft") || low.includes("rascunho")) return "drafts";
  if (low.includes("trash") || low.includes("lixeira") || low.includes("deleted")) return "trash";
  if (low.includes("spam") || low.includes("junk")) return "junk";
  if (low.includes("archive") || low.includes("arquivo")) return "archive";
  return "other";
}

export async function listFolders(accountId: string): Promise<EmailFolder[]> {
  const account = getAccount(accountId);
  if (!account) throw new Error(`Conta '${accountId}' não encontrada`);
  return withClient(account, async (client) => {
    const boxes = await client.list();
    const folders: EmailFolder[] = [];
    for (const b of boxes) {
      const path = b.path;
      let unread = 0;
      let total = 0;
      try {
        const status = await client.status(path, { messages: true, unseen: true });
        unread = status.unseen ?? 0;
        total = status.messages ?? 0;
      } catch {
        // some folders (Gmail labels) refuse STATUS — skip counts
      }
      folders.push({
        path,
        name: b.name || path,
        role: inferRole({ specialUse: b.specialUse, path, name: b.name }),
        unreadCount: unread,
        totalCount: total,
      });
    }
    folders.sort((a, b) => {
      const order = ["inbox", "sent", "drafts", "archive", "junk", "trash", "other"];
      const ra = order.indexOf(a.role || "other");
      const rb = order.indexOf(b.role || "other");
      if (ra !== rb) return ra - rb;
      return a.path.localeCompare(b.path);
    });
    return folders;
  });
}

function toEmailAddresses(input: unknown): EmailAddress[] {
  if (!input) return [];
  const out: EmailAddress[] = [];
  const items = Array.isArray(input) ? input : [input];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as { name?: string; address?: string };
    if (!obj.address) continue;
    out.push({ name: obj.name || undefined, address: obj.address });
  }
  return out;
}

function toIsoDate(input: Date | string | undefined): string {
  if (!input) return new Date().toISOString();
  if (input instanceof Date) return input.toISOString();
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function buildSnippet(msg: FetchMessageObject): string {
  const env = msg.envelope;
  if (!env) return "";
  // ImapFlow doesn't return BODYSTRUCTURE preview text — leave snippet to
  // the fetcher of the full body. For envelopes, return subject prefix
  // (the UI shows from + subject already; snippet is cosmetic).
  return "";
}

function envelopeFromFetch(
  accountId: string,
  folder: string,
  msg: FetchMessageObject,
): EmailEnvelope {
  const env = msg.envelope;
  const flags = msg.flags ?? new Set<string>();
  const hasAttachments = (() => {
    const bs = msg.bodyStructure as { childNodes?: unknown[]; disposition?: string } | undefined;
    if (!bs) return false;
    // Recursive scan for attachment disposition
    const scan = (node: { childNodes?: unknown[]; disposition?: string } | undefined): boolean => {
      if (!node) return false;
      if (node.disposition && node.disposition.toLowerCase() === "attachment") return true;
      if (Array.isArray(node.childNodes)) {
        for (const c of node.childNodes) {
          if (scan(c as typeof node)) return true;
        }
      }
      return false;
    };
    return scan(bs);
  })();

  return {
    accountId,
    uid: String(msg.uid),
    folder,
    from: toEmailAddresses(env?.from),
    to: toEmailAddresses(env?.to),
    cc: toEmailAddresses(env?.cc),
    subject: env?.subject ?? "(sem assunto)",
    snippet: buildSnippet(msg),
    date: toIsoDate(env?.date ?? msg.internalDate),
    seen: flags.has("\\Seen"),
    flagged: flags.has("\\Flagged"),
    answered: flags.has("\\Answered"),
    hasAttachments,
    messageId: env?.messageId,
    inReplyTo: env?.inReplyTo,
    references: undefined,
  };
}

export interface ListMessagesParams {
  accountIds: string[];
  folder?: string;
  q?: string;
  unread?: boolean;
  page?: number;
  limit?: number;
}

export interface MessagesPage {
  messages: EmailEnvelope[];
  total: number;
  page: number;
  limit: number;
}

async function listEnvelopesForAccount(
  account: StoredAccount,
  folder: string,
  q: string | undefined,
  unread: boolean,
  cap: number,
): Promise<EmailEnvelope[]> {
  return withClient(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const mailbox = client.mailbox as MailboxObject | false;
      if (!mailbox) return [];

      // Build search criteria
      const search: Record<string, unknown> = {};
      if (unread) search.seen = false;
      if (q && q.trim()) {
        const term = q.trim();
        // OR across common fields; ImapFlow accepts `or: [{...},{...}]`
        search.or = [
          { from: term },
          { to: term },
          { subject: term },
          { body: term },
        ];
      }

      const hasFilters = Object.keys(search).length > 0;
      let uids: number[];
      if (hasFilters) {
        const found = await client.search(search, { uid: true });
        uids = (found as number[]) ?? [];
      } else {
        // No filters — take the last N UIDs from mailbox
        const exists = mailbox.exists ?? 0;
        if (exists === 0) return [];
        // Use sequence-based fetch for "latest N"; ImapFlow accepts `${from}:${to}` seq.
        // Convert to UID via search ALL is overkill; we just fetch tail via sequence.
        // We'll use range "<from>:*" on UID by searching all and slicing.
        const all = (await client.search({ all: true }, { uid: true })) as number[];
        uids = all;
      }

      uids.sort((a, b) => b - a); // newest first (high UIDs)
      const slice = uids.slice(0, cap);
      if (slice.length === 0) return [];

      const envelopes: EmailEnvelope[] = [];
      for await (const msg of client.fetch(
        slice.join(","),
        { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true },
        { uid: true },
      )) {
        envelopes.push(envelopeFromFetch(account.id, folder, msg));
      }
      return envelopes;
    } finally {
      lock.release();
    }
  });
}

export async function listMessages(params: ListMessagesParams): Promise<MessagesPage> {
  const folder = params.folder || "INBOX";
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(200, Math.max(1, params.limit ?? 50));
  const cap = page * limit + 50; // overfetch slightly so multi-account merge is stable

  const collected: EmailEnvelope[] = [];
  for (const id of params.accountIds) {
    const account = getAccount(id);
    if (!account) continue;
    try {
      const envs = await listEnvelopesForAccount(account, folder, params.q, !!params.unread, cap);
      collected.push(...envs);
    } catch (e) {
      // skip this account — error already persisted via markAccountStatus
      void e;
    }
  }

  collected.sort((a, b) => (a.date < b.date ? 1 : -1));
  const total = collected.length;
  const start = (page - 1) * limit;
  const messages = collected.slice(start, start + limit);
  return { messages, total, page, limit };
}

export async function getMessage(
  accountId: string,
  uid: string,
  folder: string = "INBOX",
): Promise<EmailMessage> {
  const account = getAccount(accountId);
  if (!account) throw new Error(`Conta '${accountId}' não encontrada`);

  return withClient(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const downloads: Buffer[] = [];
      // Fetch envelope + flags + source for parsing
      let envelope: FetchMessageObject | null = null;
      for await (const msg of client.fetch(
        uid,
        { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true, source: true },
        { uid: true },
      )) {
        envelope = msg;
        if (msg.source) downloads.push(msg.source as Buffer);
      }
      if (!envelope) throw new Error("Mensagem não encontrada");

      const env = envelopeFromFetch(accountId, folder, envelope);

      let bodyText: string | undefined;
      let bodyHtml: string | undefined;
      const attachments: EmailMessage["attachments"] = [];
      const headers: Record<string, string> = {};

      if (downloads.length > 0) {
        const parsed = await simpleParser(downloads[0]);
        bodyText = parsed.text || undefined;
        bodyHtml = parsed.html ? String(parsed.html) : undefined;
        for (const att of parsed.attachments ?? []) {
          attachments.push({
            filename: att.filename || "arquivo",
            contentType: att.contentType || "application/octet-stream",
            size: att.size || 0,
            contentId: att.contentId,
          });
        }
        if (parsed.headers) {
          for (const [k, v] of parsed.headers.entries()) {
            headers[k] = typeof v === "string" ? v : JSON.stringify(v);
          }
        }
      }

      return {
        ...env,
        bodyText,
        bodyHtml,
        attachments: attachments.length ? attachments : undefined,
        headers: Object.keys(headers).length ? headers : undefined,
      };
    } finally {
      lock.release();
    }
  });
}

export async function setFlags(
  accountId: string,
  uid: string,
  folder: string,
  flags: { seen?: boolean; flagged?: boolean },
): Promise<void> {
  const account = getAccount(accountId);
  if (!account) throw new Error(`Conta '${accountId}' não encontrada`);

  await withClient(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const add: string[] = [];
      const remove: string[] = [];
      if (flags.seen === true) add.push("\\Seen");
      if (flags.seen === false) remove.push("\\Seen");
      if (flags.flagged === true) add.push("\\Flagged");
      if (flags.flagged === false) remove.push("\\Flagged");
      if (add.length) await client.messageFlagsAdd(uid, add, { uid: true });
      if (remove.length) await client.messageFlagsRemove(uid, remove, { uid: true });
    } finally {
      lock.release();
    }
  });
}

export async function moveMessage(
  accountId: string,
  uid: string,
  fromFolder: string,
  toFolder: string,
): Promise<void> {
  const account = getAccount(accountId);
  if (!account) throw new Error(`Conta '${accountId}' não encontrada`);

  await withClient(account, async (client) => {
    const lock = await client.getMailboxLock(fromFolder);
    try {
      await client.messageMove(uid, toFolder, { uid: true });
    } finally {
      lock.release();
    }
  });
}
