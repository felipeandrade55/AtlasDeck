import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function POST(req: NextRequest) {
  try {
    const { action, port, protocol, allowType } = await req.json();
    
    if (action === 'enable') {
      // --force para não pedir confirmação (pode interromper SSH)
      await execAsync('ufw --force enable');
      return NextResponse.json({ success: true, message: 'Firewall ativado com sucesso' });
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
