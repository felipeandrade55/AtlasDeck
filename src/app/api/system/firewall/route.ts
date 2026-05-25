import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Detecta as portas em que o SSH está realmente escutando.
 * Estratégia: `ss` (reality) → `sshd -T` (config) → fallback 22.
 */
async function detectSshPorts(): Promise<number[]> {
  const ports = new Set<number>();

  try {
    const { stdout } = await execAsync(
      `ss -tlnpH 2>/dev/null | grep -iE 'sshd|"ssh"' | awk '{print $4}' | sed 's/.*://' | sort -u`
    );
    for (const line of stdout.split('\n')) {
      const p = parseInt(line.trim(), 10);
      if (!isNaN(p) && p > 0 && p < 65536) ports.add(p);
    }
  } catch {}

  if (ports.size === 0) {
    try {
      const { stdout } = await execAsync(
        `sshd -T 2>/dev/null | awk 'tolower($1)=="port" {print $2}'`
      );
      for (const line of stdout.split('\n')) {
        const p = parseInt(line.trim(), 10);
        if (!isNaN(p) && p > 0 && p < 65536) ports.add(p);
      }
    } catch {}
  }

  if (ports.size === 0) {
    try {
      const { stdout } = await execAsync(
        `grep -hiE '^[[:space:]]*Port[[:space:]]+[0-9]+' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | awk '{print $2}'`
      );
      for (const line of stdout.split('\n')) {
        const p = parseInt(line.trim(), 10);
        if (!isNaN(p) && p > 0 && p < 65536) ports.add(p);
      }
    } catch {}
  }

  if (ports.size === 0) ports.add(22);
  return [...ports];
}

export async function GET() {
  try {
    const sshPorts = await detectSshPorts();
    return NextResponse.json({
      sshPorts,
      essentialRules: [
        ...sshPorts.map((p) => ({ port: `${p}/tcp`, label: `SSH (porta ${p})` })),
        { port: '80/tcp', label: 'HTTP' },
        { port: '443/tcp', label: 'HTTPS' },
        { port: '41641/udp', label: 'Tailscale (conexão direta)' },
        { port: 'in on tailscale0', label: 'Interface VPN Tailscale' },
      ],
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { action, port, protocol, allowType } = await req.json();

    if (action === 'enable') {
      // Pré-libera tráfego essencial ANTES do enable (UFW default = deny incoming).
      // Sem isso o usuário perde SSH ao ativar. `|| true` evita falha se a regra já existe.
      const sshPorts = await detectSshPorts();
      for (const p of sshPorts) {
        await execAsync(`ufw allow ${p}/tcp || true`);       // SSH (porta detectada)
      }
      await execAsync('ufw allow 80/tcp || true');           // HTTP
      await execAsync('ufw allow 443/tcp || true');          // HTTPS
      await execAsync('ufw allow 41641/udp || true');        // Tailscale direct connection
      await execAsync('ufw allow in on tailscale0 || true'); // Interface VPN
      await execAsync('ufw --force enable');
      return NextResponse.json({
        success: true,
        message: `Firewall ativado (SSH em ${sshPorts.join(', ')} + HTTP/HTTPS/Tailscale liberados, saída livre)`,
        sshPorts,
      });
    }

    if (action === 'disable') {
      await execAsync('ufw disable');
      return NextResponse.json({ success: true, message: 'Firewall desativado com sucesso' });
    }

    if (action === 'add') {
      if (!port) return NextResponse.json({ error: 'Porta não fornecida' }, { status: 400 });
      const proto = protocol && protocol !== 'any' ? `/${protocol}` : ''; // tcp, udp
      const allowStr = allowType === 'deny' ? 'deny' : 'allow';
      await execAsync(`ufw ${allowStr} ${port}${proto}`);
      return NextResponse.json({ success: true, message: `Regra adicionada: ${allowStr} ${port}${proto}` });
    }

    if (action === 'allow_tailscale') {
      await execAsync('ufw allow in on tailscale0');
      return NextResponse.json({ success: true, message: 'Tráfego do Tailscale liberado no firewall' });
    }

    if (action === 'lockdown') {
      // Allow tailscale first
      await execAsync('ufw allow in on tailscale0');
      // Delete allow rules for sensitive ports to block public internet.
      // Detecta a porta SSH real para também fechar o acesso público a ela.
      const sshPorts = await detectSshPorts();
      for (const p of sshPorts) {
        await execAsync(`ufw delete allow ${p}/tcp || true`);
      }
      await execAsync('ufw delete allow 3000/tcp || true');
      await execAsync('ufw delete allow 18789/tcp || true');
      await execAsync('ufw delete allow ssh || true');
      return NextResponse.json({
        success: true,
        message: `Portas públicas fechadas (incluindo SSH em ${sshPorts.join(', ')}). Acesso restrito ao Tailscale.`,
      });
    }

    return NextResponse.json({ error: 'Ação inválida' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'ID da regra não fornecido' }, { status: 400 });

    await execAsync(`ufw --force delete ${id}`);
    return NextResponse.json({ success: true, message: `Regra #${id} deletada com sucesso` });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
