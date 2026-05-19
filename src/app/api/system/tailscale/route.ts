import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function POST(req: NextRequest) {
  try {
    const { action } = await req.json();

    if (action === 'install') {
      await execAsync('curl -fsSL https://tailscale.com/install.sh | sh');
      return NextResponse.json({ success: true, message: 'Tailscale instalado com sucesso' });
    }

    if (action === 'up') {
      // Run tailscale up and try to capture the auth URL. It might output to stderr or stdout.
      // We run it with timeout so it doesn't hang forever if it waits for auth
      try {
        const { stdout, stderr } = await execAsync('timeout 5 tailscale up 2>&1 || true');
        const output = stdout + '\n' + stderr;
        
        // Extract URL like: https://login.tailscale.com/a/0123456789
        const urlMatch = output.match(/(https:\/\/login\.tailscale\.com\/a\/[a-zA-Z0-9]+)/);
        
        if (urlMatch) {
          return NextResponse.json({ success: true, authUrl: urlMatch[1], message: 'Autenticação necessária' });
        }
        
        return NextResponse.json({ success: true, message: 'Tailscale iniciado' });
      } catch (err: any) {
        return NextResponse.json({ success: true, message: 'Comando enviado, verifique o status' });
      }
    }

    return NextResponse.json({ error: 'Ação inválida' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
