/**
 * Single VPS host — get / update (name, thresholds, services, docker toggle,
 * or re-enroll token) / delete.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  getHost,
  updateHost,
  updateHostToken,
  deleteHost,
  tokenExists,
  type VpsThresholds,
  type MonitoredService,
} from '@/lib/vps-db';
import { logActivity } from '@/lib/activities-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const host = getHost(id);
  if (!host) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(host);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const host = getHost(id);
  if (!host) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const body = await request.json();

    // Re-enroll a new token (after a reinstall printed a fresh one).
    if (typeof body.token === 'string' && body.token.trim()) {
      const token = body.token.trim();
      if (token.length < 16) {
        return NextResponse.json({ error: 'Token inválido' }, { status: 400 });
      }
      if (tokenExists(token)) {
        return NextResponse.json(
          { error: 'Este token já está cadastrado em outro VPS' },
          { status: 409 }
        );
      }
      updateHostToken(id, token);
    }

    const patch: {
      name?: string;
      thresholds?: VpsThresholds;
      monitored_services?: MonitoredService[];
      monitor_docker?: boolean;
    } = {};
    if (typeof body.name === 'string') patch.name = body.name;
    if (body.thresholds && typeof body.thresholds === 'object') patch.thresholds = body.thresholds;
    if (Array.isArray(body.monitored_services))
      patch.monitored_services = body.monitored_services;
    if (typeof body.monitor_docker === 'boolean') patch.monitor_docker = body.monitor_docker;

    const updated = updateHost(id, patch);
    return NextResponse.json(updated);
  } catch (err) {
    console.error('[/api/vps/[id]] update failed:', err);
    return NextResponse.json({ error: 'Failed to update VPS host' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const host = getHost(id);
  if (!host) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    deleteHost(id);
    try {
      logActivity('config', `VPS removido: ${host.name}`, 'success', {
        metadata: { source: 'vps-monitor', vps_id: id },
      });
    } catch {}
    return NextResponse.json({ success: true, deleted: id });
  } catch (err) {
    console.error('[/api/vps/[id]] delete failed:', err);
    return NextResponse.json({ error: 'Failed to delete VPS host' }, { status: 500 });
  }
}
