import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function getTailscaleStatus() {
  try {
    const { stdout } = await execAsync("tailscale status --json 2>/dev/null || echo '{}'");
    const data = JSON.parse(stdout.trim() || '{}');
    return data;
  } catch {
    return {};
  }
}

export async function GET() {
  try {
    const data = await getTailscaleStatus();
    const backendState = data.BackendState || 'NotInstalled';

    const devices: { ip: string; hostname: string; os: string; online: boolean }[] = [];
    if (data.Peer) {
      for (const peer of Object.values(data.Peer) as any[]) {
        devices.push({
          ip: peer.TailscaleIPs?.[0] || '',
          hostname: peer.HostName || '',
          os: peer.OS || '',
          online: peer.Online || peer.Active || false,
        });
      }
    }

    return NextResponse.json({
      backendState,
      authUrl: data.AuthURL || '',
      ip: data.TailscaleIPs?.[0] || '',
      rxBytes: data.Self?.RxBytes || 0,
      txBytes: data.Self?.TxBytes || 0,
      devices,
      installed: !!data.BackendState,
      active: backendState === 'Running',
    });
  } catch (error: any) {
    return NextResponse.json({ backendState: 'NotInstalled', authUrl: '', ip: '', rxBytes: 0, txBytes: 0, devices: [], installed: false, active: false });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { action } = await req.json();

    if (action === 'install') {
      await execAsync('curl -fsSL https://tailscale.com/install.sh | sh');
      // Auto-allow tailscale in firewall
      await execAsync('ufw allow in on tailscale0 2>/dev/null || true');
      await execAsync('ufw allow 41641/udp 2>/dev/null || true');
      return NextResponse.json({ success: true, message: 'Tailscale instalado e firewall configurado' });
    }

    if (action === 'up' || action === 'start') {
      const { stdout, stderr } = await execAsync('timeout 10 tailscale up 2>&1 || true');
      const output = stdout + '\n' + stderr;
      const urlMatch = output.match(/(https:\/\/login\.tailscale\.com\/[^\s]+)/);
      if (urlMatch) {
        return NextResponse.json({ success: true, authUrl: urlMatch[1], message: 'Autenticação necessária' });
      }
      // Check JSON for auth URL (sometimes it's there but not in stdout)
      const tsData = await getTailscaleStatus();
      if (tsData.AuthURL) {
        return NextResponse.json({ success: true, authUrl: tsData.AuthURL, message: 'Autenticação necessária' });
      }
      return NextResponse.json({ success: true, message: 'Tailscale iniciado' });
    }

    if (action === 'stop') {
      await execAsync('tailscale down 2>&1 || true');
      return NextResponse.json({ success: true, message: 'Tailscale parado' });
    }

    if (action === 'restart') {
      await execAsync('tailscale down 2>&1 || true');
      await new Promise(r => setTimeout(r, 1500));
      const { stdout, stderr } = await execAsync('timeout 10 tailscale up 2>&1 || true');
      const output = stdout + '\n' + stderr;
      const urlMatch = output.match(/(https:\/\/login\.tailscale\.com\/[^\s]+)/);
      if (urlMatch) {
        return NextResponse.json({ success: true, authUrl: urlMatch[1], message: 'Autenticação necessária após restart' });
      }
      const tsData = await getTailscaleStatus();
      if (tsData.AuthURL) {
        return NextResponse.json({ success: true, authUrl: tsData.AuthURL, message: 'Autenticação necessária após restart' });
      }
      return NextResponse.json({ success: true, message: 'Tailscale reiniciado' });
    }

    if (action === 'allow_firewall') {
      await execAsync('ufw allow in on tailscale0 2>/dev/null || true');
      await execAsync('ufw allow 41641/udp 2>/dev/null || true');
      return NextResponse.json({ success: true, message: 'Firewall configurado para Tailscale' });
    }

    return NextResponse.json({ error: 'Ação inválida' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
