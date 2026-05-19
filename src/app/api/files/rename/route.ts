import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { logActivity } from '@/lib/activities-db';
import { resolveWorkspacePath } from '@/lib/workspace-resolver';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { workspace, path: filePath, newName } = body;

    if (!filePath || !newName || typeof newName !== 'string') {
      return NextResponse.json({ error: 'Missing path or newName' }, { status: 400 });
    }

    const base = resolveWorkspacePath(workspace || 'workspace');
    if (!base) {
      return NextResponse.json({ error: 'Unknown workspace' }, { status: 400 });
    }

    const fullPath = path.resolve(base, filePath);
    if (!fullPath.startsWith(base)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }

    const dir = path.dirname(fullPath);
    const newPath = path.join(dir, path.basename(newName));

    if (!newPath.startsWith(base)) {
      return NextResponse.json({ error: 'Invalid newName' }, { status: 400 });
    }

    await fs.rename(fullPath, newPath);

    logActivity('file_write', `Renamed ${path.basename(filePath)} to ${newName}`, 'success', {
      metadata: { workspace, oldPath: filePath, newName },
    });

    return NextResponse.json({ success: true, newPath: path.relative(base, newPath) });
  } catch (error) {
    console.error('[rename] Error:', error);
    return NextResponse.json({ error: 'Rename failed' }, { status: 500 });
  }
}
