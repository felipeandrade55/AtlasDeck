import { NextResponse } from 'next/server';
import { scanAllSkills } from '@/lib/skill-parser';

export async function GET() {
  try {
    const skills = scanAllSkills();
    const missing = skills.filter((s) => s.missing).length;

    return NextResponse.json({
      skills,
      total: skills.length,
      missing,
    });
  } catch (error) {
    console.error('Failed to scan skills:', error);
    return NextResponse.json({ skills: [], total: 0, missing: 0 }, { status: 500 });
  }
}
