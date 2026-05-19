import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { logActivity } from '@/lib/activities-db';
import { resolveWorkspacePath } from '@/lib/workspace-resolver';

function resolvePath(workspace: string, filePath: string): string | null {
  const base = resolveWorkspacePath(workspace);
  if (!base) return null;
  const full = path.resolve(base, filePath);
  if (!full.startsWith(base)) return null; // path traversal check
  return full;
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const workspace = (formData.get('workspace') as string) || 'workspace';
    const dirPath = (formData.get('path') as string) || '';
    const files = formData.getAll('files') as File[];

    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    const base = resolveWorkspacePath(workspace);
    if (!base) {
      return NextResponse.json({ error: 'Unknown workspace' }, { status: 400 });
    }

    const results: Array<{ name: string; size: number; path: string }> = [];

    for (const file of files) {
      const relativePath = (file as any).webkitRelativePath as string | undefined;
      const sanitizedName = path.basename(file.name);

      // If webkitRelativePath is provided (folder upload), use its directory structure
      let targetDir: string;
      if (relativePath) {
        const subDir = path.dirname(relativePath);
        targetDir = path.resolve(base, dirPath, subDir);
      } else {
        targetDir = path.resolve(base, dirPath);
      }

      if (!targetDir.startsWith(base)) {
        continue; // skip unsafe
      }

      await fs.mkdir(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, sanitizedName);

      const buffer = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(targetPath, buffer);

      const resultPath = relativePath
        ? (dirPath ? `${dirPath}/${relativePath}` : relativePath)
        : (dirPath ? `${dirPath}/${sanitizedName}` : sanitizedName);

      results.push({
        name: sanitizedName,
        size: buffer.length,
        path: resultPath,
      });
    }

    logActivity('file_write', `Uploaded ${results.length} file(s) to ${workspace}/${dirPath || '/'}`, 'success', {
      metadata: { files: results.map((r) => r.name), workspace, dirPath },
    });

    return NextResponse.json({ success: true, files: results });
  } catch (error) {
    console.error('[upload] Error:', error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
