/**
 * Memory full-text search API
 * GET /api/memory/search?q=<query>&workspace=<id>&limit=<n>
 *
 * Backed by SQLite FTS5 (see src/lib/memory-fts.ts). Performs an
 * incremental sync of the requested workspace before searching so
 * out-of-band writes (e.g. by the OpenClaw CLI) are picked up.
 */
import { NextRequest, NextResponse } from 'next/server';
import { searchMemoryFiles, syncWorkspace } from '@/lib/memory-fts';

const MAX_QUERY_LENGTH = 200;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = (searchParams.get('q') || '').trim();
  const workspace = searchParams.get('workspace') || 'workspace';
  const limitParam = Number.parseInt(searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(limitParam) ? limitParam : 20;

  if (query.length > MAX_QUERY_LENGTH) {
    return NextResponse.json(
      { error: `Query too long (max ${MAX_QUERY_LENGTH} chars)` },
      { status: 400 },
    );
  }

  if (query.length < 2) {
    return NextResponse.json({ results: [], query, total: 0 });
  }

  try {
    await syncWorkspace(workspace);
    const results = searchMemoryFiles(query, { workspace, limit });
    return NextResponse.json({ results, query, total: results.length });
  } catch (error) {
    console.error('[memory/search] Error:', error);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
