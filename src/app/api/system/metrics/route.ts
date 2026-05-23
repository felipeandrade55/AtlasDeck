import { NextResponse } from "next/server";
import { querySeries, type MetricKey, type RangeKey } from "@/lib/metrics-db";

const VALID_RANGES: RangeKey[] = ['3h', '12h', '24h', '72h', '7d', '30d', '90d', '1y'];
const VALID_METRICS: MetricKey[] = [
  'cpu_usage',
  'cpu_temp',
  'ram_used_pct',
  'disk_used_pct',
  'net_rx_mbps',
  'net_tx_mbps',
];

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const rawRange = (searchParams.get('range') || '24h') as RangeKey;
  const range = VALID_RANGES.includes(rawRange) ? rawRange : '24h';

  const metricsParam = searchParams.get('metrics');
  const requested = metricsParam
    ? (metricsParam.split(',').filter(m => VALID_METRICS.includes(m as MetricKey)) as MetricKey[])
    : VALID_METRICS;

  try {
    const data = querySeries(range, requested);
    return NextResponse.json(data);
  } catch (err) {
    console.error('[/api/system/metrics] query failed:', err);
    return NextResponse.json({ error: 'Failed to query metrics' }, { status: 500 });
  }
}
