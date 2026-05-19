import { NextResponse } from 'next/server';
import fs from 'fs';
import { getSkillsScanInfo } from '@/lib/skill-parser';

export async function GET() {
  const info = getSkillsScanInfo();

  // Check which paths actually exist on disk
  const pathChecks = {
    systemPath: {
      path: info.systemPath,
      exists: fs.existsSync(info.systemPath),
      contents: (() => {
        try {
          return fs.readdirSync(info.systemPath);
        } catch {
          return [];
        }
      })(),
    },
    workspaceSkillsDirs: info.workspaceSkillsDirs.map((dir) => ({
      path: dir,
      exists: fs.existsSync(dir),
      contents: (() => {
        try {
          return fs.readdirSync(dir);
        } catch {
          return [];
        }
      })(),
    })),
  };

  return NextResponse.json({
    ...info,
    pathChecks,
  });
}
