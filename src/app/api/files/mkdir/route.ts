import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { resolveWorkspacePath } from '@/lib/workspace-resolver';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { workspace, path: dirPath, name } = body;

    if (!dirPath && !name) {
      return NextResponse.json({ error: 'Missing path or name' }, { status: 400 });
    }

    const base = resolveWorkspacePath(workspace || 'workspace');
    if (!base) {
      return NextResponse.json({ error: 'Unknown workspace' }, { status: 400 });
    }

    const targetPath = name
      ? path.resolve(base, dirPath || '', name)
      : path.resolve(base, dirPath);

    if (!targetPath.startsWith(base)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }

    await fs.mkdir(targetPath, { recursive: true });

    return NextResponse.json({ success: true, path: path.relative(base, targetPath) });
  } catch (error) {
    console.error('[mkdir] Error:', error);
    return NextResponse.json({ error: 'Failed to create directory' }, { status: 500 });
  }
}
