/**
 * Memory FTS index management.
 *
 *   GET  /api/memory/index — return current stats
 *   POST /api/memory/index — rebuild the full FTS index across every workspace
 */
import { NextResponse } from 'next/server';
import { getIndexStats, rebuildAll } from '@/lib/memory-fts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getIndexStats());
}

export async function POST() {
  try {
    const result = await rebuildAll();
    const stats = getIndexStats();
    return NextResponse.json({ success: true, ...result, stats });
  } catch (error) {
    console.error('[memory/index] Rebuild failed:', error);
    return NextResponse.json(
      { error: 'Rebuild failed' },
      { status: 500 },
    );
  }
}
