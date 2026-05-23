import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getSkillsScanInfo, scanAllSkills } from '@/lib/skill-parser';

function inspect(p: string) {
  let exists = false;
  let contents: string[] = [];
  try {
    exists = fs.existsSync(p);
    if (exists) contents = fs.readdirSync(p);
  } catch {}
  return { path: p, exists, contents };
}

export async function GET() {
  const info = getSkillsScanInfo();
  const home = os.homedir();

  const extraPaths = [
    path.join(info.openclawDir || '', 'skills', '.system'),
    path.join(info.openclawDir || '', 'vendor_imports', 'skills', 'skills', '.curated'),
    path.join(info.openclawDir || '', '.tmp', 'plugins'),
    path.join(info.openclawDir || '', 'agents'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.claude', 'plugins'),
  ].filter((p) => !p.startsWith(path.sep + 'skills'));

  const skills = scanAllSkills();
  const summary = {
    total: skills.length,
    bySource: skills.reduce<Record<string, number>>((acc, s) => {
      const k = (s.source as string) + (s.missing ? '/missing' : '');
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    byLocationPrefix: skills.reduce<Record<string, number>>((acc, s) => {
      const prefix = s.location.split(path.sep).slice(0, 5).join('/');
      acc[prefix] = (acc[prefix] || 0) + 1;
      return acc;
    }, {}),
  };

  return NextResponse.json({
    ...info,
    pathChecks: {
      systemPath: inspect(info.systemPath),
      workspaceSkillsDirs: info.workspaceSkillsDirs.map(inspect),
      extra: extraPaths.map(inspect),
    },
    summary,
  });
}
