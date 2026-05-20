import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { logActivity } from '@/lib/activities-db';
import { resolveWorkspacePath } from '@/lib/workspace-resolver';
import { PROTECTED_FILES, sanitizeWorkspaceRelativePath } from '@/lib/memory-files';
import { removeFile } from '@/lib/memory-fts';

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { workspace, path: filePath } = body;

    if (!filePath) {
      return NextResponse.json({ error: 'Missing path' }, { status: 400 });
    }

    const base = resolveWorkspacePath(workspace || 'workspace');
    if (!base) {
      return NextResponse.json({ error: 'Unknown workspace' }, { status: 400 });
    }

    const fullPath = path.resolve(base, filePath);
    if (!fullPath.startsWith(base)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }

    const filename = path.basename(fullPath);
    if ((PROTECTED_FILES as readonly string[]).includes(filename)) {
      return NextResponse.json(
        { error: `Cannot delete protected file: ${filename}` },
        { status: 403 },
      );
    }

    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      await fs.rm(fullPath, { recursive: true });
    } else {
      await fs.unlink(fullPath);
    }

    logActivity(
      'file_write',
      `Deleted ${stat.isDirectory() ? 'folder' : 'file'}: ${filePath}`,
      'success',
      { metadata: { workspace, filePath } },
    );

    // Best-effort FTS cleanup. Only memory-tracked paths matter here.
    const relForIndex = path.relative(base, fullPath).replace(/\\/g, '/');
    const safeRel = sanitizeWorkspaceRelativePath(relForIndex);
    if (safeRel) {
      removeFile(workspace || 'workspace', safeRel);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[delete] Error:', error);
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }
}
