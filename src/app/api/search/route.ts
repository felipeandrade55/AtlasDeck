/**
 * Global cross-index search.
 * GET /api/search?q=<query>
 *
 * Fans out across every searchable source so ⌘K finds anything: transcriptions
 * (incl. tags/topics via FTS), memories (structured + markdown), chat messages
 * (FTS), reminders, calendar events and the activity log. Each source is
 * queried independently and failures are isolated — one broken DB never blanks
 * the whole result set.
 */
import { NextResponse } from 'next/server';
import { searchMemoryFiles, syncWorkspace } from '@/lib/memory-fts';
import { listMemories } from '@/lib/memory-db';
import { getActivities } from '@/lib/activities-db';
import { searchTranscriptions } from '@/lib/transcriptions-db';
import { searchMessages } from '@/lib/chat-db';
import { listAllReminders } from '@/lib/reminders-db';
import { listAllEvents } from '@/lib/calendar-db';

type ResultType =
  | 'transcription'
  | 'memory'
  | 'chat'
  | 'reminder'
  | 'event'
  | 'activity';

interface SearchResult {
  type: ResultType;
  title: string;
  snippet: string;
  href?: string;
  path?: string;
  timestamp?: string;
  workspace?: string;
}

const MAX_QUERY_LENGTH = 200;
const PER_SOURCE = 6;
const MAX_RESULTS = 30;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Case/diacritic-insensitive substring match for the LIKE-style sources. */
function matches(haystack: string | null | undefined, needleLower: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needleLower);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = (searchParams.get('q') || '').trim();
  const workspace = searchParams.get('workspace') || 'workspace';

  if (query.length > MAX_QUERY_LENGTH) {
    return NextResponse.json([], { status: 400 });
  }
  if (query.length < 2) {
    return NextResponse.json([]);
  }

  const qLower = query.toLowerCase();
  const results: SearchResult[] = [];

  // 1. Transcriptions (FTS — includes title, summary, text and topics/tags)
  try {
    const hits = searchTranscriptions(query, PER_SOURCE);
    for (const h of hits) {
      results.push({
        type: 'transcription',
        title: h.title,
        snippet: h.snippet || h.summary || '',
        href: `/transcriptions?id=${encodeURIComponent(h.id)}`,
        timestamp: h.created_at,
      });
    }
  } catch (error) {
    console.error('[search] transcriptions failed:', error);
  }

  // 2. Structured memories (title/content/summary LIKE) — where transcriptions,
  //    the agent and manual notes are saved.
  try {
    const { memories } = listMemories({ workspace, search: query, limit: PER_SOURCE });
    for (const m of memories) {
      results.push({
        type: 'memory',
        title: m.title,
        snippet: m.summary || m.content.slice(0, 160),
        href: `/memory?id=${encodeURIComponent(m.id)}`,
        timestamp: m.created_at,
      });
    }
  } catch (error) {
    console.error('[search] memories (db) failed:', error);
  }

  // 3. Memory markdown files (FTS)
  try {
    await syncWorkspace(workspace);
    const hits = searchMemoryFiles(query, { workspace, limit: PER_SOURCE });
    for (const h of hits) {
      results.push({
        type: 'memory',
        title: h.title,
        snippet: h.snippet,
        path: h.path,
        workspace: h.workspace,
      });
    }
  } catch (error) {
    console.error('[search] memory files failed:', error);
  }

  // 4. Chat messages (FTS)
  try {
    const hits = searchMessages(query, PER_SOURCE);
    for (const h of hits) {
      results.push({
        type: 'chat',
        title: h.thread?.title || 'Conversa',
        snippet: h.snippet || h.message?.content?.slice(0, 160) || '',
        href: `/chat?thread=${encodeURIComponent(h.thread?.id ?? '')}`,
        timestamp: h.message?.created_at,
      });
    }
  } catch (error) {
    console.error('[search] chat failed:', error);
  }

  // 5. Reminders (LIKE on text — no native search)
  try {
    const reminders = listAllReminders()
      .filter((r) => matches(r.text, qLower))
      .slice(0, PER_SOURCE);
    for (const r of reminders) {
      results.push({
        type: 'reminder',
        title: r.text,
        snippet: r.completed ? 'Concluído' : r.due_at ? `Vence em ${fmtDate(r.due_at)}` : 'Pendente',
        href: '/reminders',
        timestamp: r.due_at || r.created_at,
      });
    }
  } catch (error) {
    console.error('[search] reminders failed:', error);
  }

  // 6. Calendar events (LIKE on title/description/location — no native search)
  try {
    const events = listAllEvents()
      .filter((e) => matches(e.title, qLower) || matches(e.description, qLower) || matches(e.location, qLower))
      .slice(0, PER_SOURCE);
    for (const e of events) {
      results.push({
        type: 'event',
        title: e.title,
        snippet: [fmtDate(e.start_at), e.location].filter(Boolean).join(' · ') || (e.description ?? ''),
        href: '/calendar',
        timestamp: e.start_at,
      });
    }
  } catch (error) {
    console.error('[search] events failed:', error);
  }

  // 7. Activity log (LIKE on description)
  try {
    const { activities } = getActivities({ search: query, limit: PER_SOURCE });
    for (const a of activities) {
      results.push({
        type: 'activity',
        title: a.description,
        snippet: a.type,
        href: '/logs',
        timestamp: a.timestamp,
      });
    }
  } catch (error) {
    console.error('[search] activities failed:', error);
  }

  return NextResponse.json(results.slice(0, MAX_RESULTS));
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
