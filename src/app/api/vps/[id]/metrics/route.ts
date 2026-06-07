/**
 * Time-series query for one VPS host. Mirrors /api/system/metrics but scoped
 * by vps_id.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  querySeries,
  VPS_METRIC_KEYS,
  type VpsMetricKey,
  type RangeKey,
} from '@/lib/vps-metrics-db';
import { getHost } from '@/lib/vps-db';

export const dynamic = 'force-dynamic';

const VALID_RANGES: RangeKey[] = ['3h', '12h', '24h', '72h', '7d', '30d', '90d', '1y'];

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getHost(id)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const rawRange = (searchParams.get('range') || '24h') as RangeKey;
  const range = VALID_RANGES.includes(rawRange) ? rawRange : '24h';

  const metricsParam = searchParams.get('metrics');
  const requested = metricsParam
    ? (metricsParam
        .split(',')
        .filter((m) => VPS_METRIC_KEYS.includes(m as VpsMetricKey)) as VpsMetricKey[])
    : VPS_METRIC_KEYS;

  try {
    const data = querySeries(id, range, requested);
    return NextResponse.json(data);
  } catch (err) {
    console.error('[/api/vps/[id]/metrics] query failed:', err);
    return NextResponse.json({ error: 'Failed to query metrics' }, { status: 500 });
  }
}
