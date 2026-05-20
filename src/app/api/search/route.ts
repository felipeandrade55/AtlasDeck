/**
 * Global cross-index search.
 * GET /api/search?q=<query>
 *
 * Combines memory files (via FTS5) with activities (SQLite). The
 * previous version still read data/activities.json which has been
 * dead since activities migrated to better-sqlite3.
 */
import { NextResponse } from 'next/server';
import { searchMemoryFiles, syncWorkspace } from '@/lib/memory-fts';
import { getActivities } from '@/lib/activities-db';

interface SearchResult {
  type: 'memory' | 'activity';
  title: string;
  snippet: string;
  path?: string;
  timestamp?: string;
  workspace?: string;
}

const MAX_QUERY_LENGTH = 200;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  const results: SearchResult[] = [];

  try {
    await syncWorkspace(workspace);
    const memoryHits = searchMemoryFiles(query, { workspace, limit: 10 });
    for (const hit of memoryHits) {
      results.push({
        type: 'memory',
        title: hit.title,
        snippet: hit.snippet,
        path: hit.path,
        workspace: hit.workspace,
      });
    }
  } catch (error) {
    console.error('[search] Memory search failed:', error);
  }

  try {
    const { activities } = getActivities({ search: query, limit: 10 });
    for (const activity of activities) {
      results.push({
        type: 'activity',
        title: activity.type,
        snippet: activity.description,
        timestamp: activity.timestamp,
      });
    }
  } catch (error) {
    console.error('[search] Activities search failed:', error);
  }

  return NextResponse.json(results.slice(0, 20));
}
