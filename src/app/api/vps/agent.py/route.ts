/** Serves the Python agent source verbatim (for manual re-pulls). */
import { AGENT_PY } from '@/lib/vps-agent-source';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return new Response(AGENT_PY, {
    headers: {
      'Content-Type': 'text/x-python; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
