import { NextRequest, NextResponse } from 'next/server';
import { logActivity, getActivities, getActivityStats, getAgents } from '@/lib/activities-db';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const type = searchParams.get('type') || undefined;
    const status = searchParams.get('status') || undefined;
    const agent = searchParams.get('agent') || undefined;
    const search = searchParams.get('search') || undefined;
    const startDate = searchParams.get('startDate') || undefined;
    const endDate = searchParams.get('endDate') || undefined;
    const sort = (searchParams.get('sort') || 'newest') as 'newest' | 'oldest';
    const format = searchParams.get('format') || 'json';
    const pinned = searchParams.get('pinned') === 'true';
    const withStats = searchParams.get('withStats') === 'true';
    const limit = Math.min(parseInt(searchParams.get('limit') || '25'), format === 'csv' ? 10000 : 100);
    const offset = parseInt(searchParams.get('offset') || '0');

    const result = getActivities({ type, status, agent, search, startDate, endDate, sort, limit, offset, pinned });

    // CSV export
    if (format === 'csv') {
      const header = 'id,timestamp,type,description,status,duration_ms,tokens_used,agent,pinned\n';
      const rows = result.activities.map((a) => [
        a.id, a.timestamp, a.type,
        `"${(a.description || '').replace(/"/g, '""')}"`,
        a.status, a.duration_ms ?? '', a.tokens_used ?? '',
        a.agent ?? '', a.pinned ? '1' : '0',
      ].join(',')).join('\n');
      const csv = header + rows;
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="activities-${new Date().toISOString().split('T')[0]}.csv"`,
          'Cache-Control': 'no-store, max-age=0, must-revalidate',
        },
      });
    }

    // Include agents list for filter dropdown
    const agents = getAgents();

    const response: Record<string, unknown> = {
      activities: result.activities,
      total: result.total,
      limit,
      offset,
      hasMore: offset + limit < result.total,
      agents,
    };

    if (withStats) {
      const stats = getActivityStats();
      const successCount = stats.byStatus.success || 0;
      const total7d = Object.values(stats.byStatus).reduce((a, b) => a + b, 0);
      response.stats = {
        today: stats.today,
        successRate: total7d > 0 ? Math.round((successCount / stats.total) * 100) : 0,
        avgDuration: stats.avgDuration,
        totalTokens: stats.totalTokens,
        byType: stats.byType,
        byStatus: stats.byStatus,
      };
    }

    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      },
    });
  } catch (error) {
    console.error('Failed to get activities:', error);
    return NextResponse.json(
      { error: 'Failed to get activities' },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, max-age=0, must-revalidate',
        },
      }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Toggle pin action
    if (body.action === 'pin' && body.id) {
      const { togglePinActivity } = await import('@/lib/activities-db');
      const pinned = togglePinActivity(body.id);
      return NextResponse.json({ pinned });
    }

    if (!body.type || !body.description || !body.status) {
      return NextResponse.json(
        { error: 'Missing required fields: type, description, status' },
        { status: 400 }
      );
    }

    const validStatuses = ['success', 'error', 'pending', 'running'];
    if (!validStatuses.includes(body.status)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` },
        { status: 400 }
      );
    }

    const activity = logActivity(body.type, body.description, body.status, {
      duration_ms: body.duration_ms ?? null,
      tokens_used: body.tokens_used ?? null,
      agent: body.agent ?? null,
      metadata: body.metadata ?? null,
    });

    return NextResponse.json(activity, { status: 201 });
  } catch (error) {
    console.error('Failed to save activity:', error);
    return NextResponse.json({ error: 'Failed to save activity' }, { status: 500 });
  }
}
