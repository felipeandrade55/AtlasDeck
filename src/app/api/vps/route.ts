/**
 * VPS host registry — list + create (manual token enrollment).
 *
 * POST takes the name + the raw token the installer printed on the VPS.
 * We store only sha256(token). Same-token re-enrollment is rejected so the
 * user notices a duplicate paste.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listHosts, createHost, tokenExists } from '@/lib/vps-db';
import { logActivity } from '@/lib/activities-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const hosts = listHosts();
    return NextResponse.json(hosts);
  } catch (err) {
    console.error('[/api/vps] list failed:', err);
    return NextResponse.json({ error: 'Failed to list VPS hosts' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const token = typeof body.token === 'string' ? body.token.trim() : '';

    if (!name) {
      return NextResponse.json({ error: 'Nome é obrigatório' }, { status: 400 });
    }
    if (!token || token.length < 16) {
      return NextResponse.json(
        { error: 'Token inválido — cole o token gerado pelo script no VPS' },
        { status: 400 }
      );
    }
    if (tokenExists(token)) {
      return NextResponse.json(
        { error: 'Este token já está cadastrado em outro VPS' },
        { status: 409 }
      );
    }

    const host = createHost({ name, rawToken: token });
    try {
      logActivity('config', `VPS cadastrado: ${name}`, 'success', {
        metadata: { source: 'vps-monitor', vps_id: host.vps_id },
      });
    } catch {}

    return NextResponse.json(host, { status: 201 });
  } catch (err) {
    console.error('[/api/vps] create failed:', err);
    return NextResponse.json({ error: 'Failed to create VPS host' }, { status: 500 });
  }
}
