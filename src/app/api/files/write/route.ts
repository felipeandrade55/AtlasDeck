/**
 * Write file content endpoint
 * POST /api/files/write
 * Body: { workspace, path, content }
 */
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { logActivity } from '@/lib/activities-db';
import { resolveWorkspacePath } from '@/lib/workspace-resolver';
import { sanitizeWorkspaceRelativePath } from '@/lib/memory-files';
import { indexFile } from '@/lib/memory-fts';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { workspace, path: filePath, content } = body;

    if (!filePath || content === undefined) {
      return NextResponse.json({ error: 'Missing path or content' }, { status: 400 });
    }

    const base = resolveWorkspacePath(workspace || 'workspace');
    if (!base) {
      return NextResponse.json({ error: 'Unknown workspace' }, { status: 400 });
    }

    const fullPath = path.resolve(base, filePath);
    if (!fullPath.startsWith(base)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }

    // Create parent directories if needed
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');

    const stat = await fs.stat(fullPath);

    logActivity('file_write', `Edited file: ${filePath}`, 'success', {
      metadata: { workspace, filePath, size: stat.size },
    });

    // Keep FTS index in sync for memory-tracked paths.
    const relForIndex = path.relative(base, fullPath).replace(/\\/g, '/');
    const safeRel = sanitizeWorkspaceRelativePath(relForIndex);
    if (safeRel) {
      await indexFile(workspace || 'workspace', safeRel, fullPath);
    }

    return NextResponse.json({ success: true, path: filePath, size: stat.size });
  } catch (error) {
    console.error('[write] Error:', error);
    return NextResponse.json({ error: 'Write failed' }, { status: 500 });
  }
}
