import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { logActivity } from '@/lib/activities-db';
import { resolveWorkspacePath } from '@/lib/workspace-resolver';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { workspace, path: filePath, destination } = body;

    if (!filePath || !destination || typeof destination !== 'string') {
      return NextResponse.json({ error: 'Missing path or destination' }, { status: 400 });
    }

    const base = resolveWorkspacePath(workspace || 'workspace');
    if (!base) {
      return NextResponse.json({ error: 'Unknown workspace' }, { status: 400 });
    }

    const fullPath = path.resolve(base, filePath);
    if (!fullPath.startsWith(base)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }

    const destPath = path.resolve(base, destination, path.basename(filePath));
    if (!destPath.startsWith(base)) {
      return NextResponse.json({ error: 'Invalid destination' }, { status: 400 });
    }

    // Ensure destination directory exists
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.rename(fullPath, destPath);

    logActivity('file_write', `Moved ${path.basename(filePath)} to ${destination}`, 'success', {
      metadata: { workspace, oldPath: filePath, destination },
    });

    return NextResponse.json({ success: true, newPath: path.relative(base, destPath) });
  } catch (error) {
    console.error('[move] Error:', error);
    return NextResponse.json({ error: 'Move failed' }, { status: 500 });
  }
}
