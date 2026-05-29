/**
 * Activity Stats API
 * GET /api/activities/stats
 * Returns heatmap data, counts by type, status, and recent trend
 */
import { NextResponse } from 'next/server';
import { getActivityStats } from '@/lib/activities-db';
import Database from 'better-sqlite3';
import path from 'path';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const stats = getActivityStats();

    // Also get heatmap data (last 52 weeks = 364 days)
    const DB_PATH = path.join(process.cwd(), 'data', 'activities.db');
    const db = new Database(DB_PATH);

    const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const heatmapRows = db.prepare(`
      SELECT DATE(timestamp) as day, COUNT(*) as count
      FROM activities
      WHERE timestamp >= ?
      GROUP BY DATE(timestamp)
      ORDER BY day
    `).all(cutoff) as Array<{ day: string; count: number }>;

    // Recent trend (last 7 days)
    const trendRows = db.prepare(`
      SELECT DATE(timestamp) as day, COUNT(*) as count,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
      FROM activities
      WHERE timestamp >= datetime('now', '-7 days')
      GROUP BY DATE(timestamp)
      ORDER BY day DESC
    `).all() as Array<{ day: string; count: number; success: number; errors: number }>;

    // Most active hour of day
    const hourRows = db.prepare(`
      SELECT strftime('%H', timestamp) as hour, COUNT(*) as count
      FROM activities
      WHERE timestamp >= datetime('now', '-30 days')
      GROUP BY hour
      ORDER BY count DESC
      LIMIT 24
    `).all() as Array<{ hour: string; count: number }>;

    db.close();

    return NextResponse.json({
      ...stats,
      heatmap: heatmapRows,
      trend: trendRows,
      hourly: hourRows,
    }, {
      headers: {
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      },
    });
  } catch (error) {
    console.error('[activities/stats] Error:', error);
    return NextResponse.json(
      { error: 'Failed to get stats' },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, max-age=0, must-revalidate',
        },
      }
    );
  }
}
