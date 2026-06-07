/**
 * Serves the generic bash installer (text/plain). No token in the URL — the
 * script GENERATES the token on the VPS and prints it at the end; the user
 * then pastes it into AtlasDeck to authorize the host. This same text is what
 * the "Copiar script" button in the UI copies to the clipboard.
 */
import { NextRequest } from 'next/server';
import { AGENT_PY } from '@/lib/vps-agent-source';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function resolvePublicUrl(req: NextRequest): string {
  const raw =
    process.env.VPS_INGEST_PUBLIC_URL ||
    process.env.NEXT_PUBLIC_PUBLIC_BASE_URL ||
    req.nextUrl.origin;
  return raw.replace(/\/+$/, '');
}

export async function GET(req: NextRequest) {
  const publicUrl = resolvePublicUrl(req);
  const script = buildInstaller(publicUrl);
  return new Response(script, {
    headers: {
      'Content-Type': 'text/x-shellscript; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function buildInstaller(publicUrl: string): string {
  // Only ${publicUrl} and ${AGENT_PY} are JS interpolations; every bash
  // variable uses $VAR (no braces) so the template literal leaves it intact.
  return `#!/usr/bin/env bash
set -euo pipefail

INGEST_URL="${publicUrl}/api/vps/ingest"
AGENT_DIR="/opt/atlasdeck-agent"
CONF_DIR="/etc/atlasdeck-agent"
CONF="$CONF_DIR/config.json"
SPOOL="/var/lib/atlasdeck-agent/spool.ndjson"

if [ "$(id -u)" != "0" ]; then
  echo "ERRO: rode como root (sudo bash install.sh)" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERRO: python3 nao encontrado. Instale: apt-get install -y python3" >&2
  exit 1
fi

mkdir -p "$AGENT_DIR" "$CONF_DIR" /var/lib/atlasdeck-agent

cat > "$AGENT_DIR/agent.py" <<'ATLASDECK_AGENT_EOF'
${AGENT_PY}
ATLASDECK_AGENT_EOF

# Reuse an existing token if this VPS was already enrolled; else generate one.
if [ -f "$CONF" ] && python3 -c "import json,sys; t=json.load(open('$CONF')).get('token'); sys.exit(0 if t else 1)" 2>/dev/null; then
  TOKEN="$(python3 -c "import json;print(json.load(open('$CONF'))['token'])")"
else
  TOKEN="$(python3 -c 'import secrets;print(secrets.token_hex(32))')"
fi

cat > "$CONF" <<EOF
{
  "ingestUrl": "$INGEST_URL",
  "token": "$TOKEN",
  "intervalSec": 30,
  "topN": 10,
  "spoolPath": "$SPOOL",
  "spoolMaxBytes": 10485760,
  "services": [],
  "dockerStatsEveryTicks": 2
}
EOF
chmod 600 "$CONF"

cat > /etc/systemd/system/atlasdeck-agent.service <<EOF
[Unit]
Description=AtlasDeck VPS monitoring agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 $AGENT_DIR/agent.py
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now atlasdeck-agent >/dev/null 2>&1 || systemctl restart atlasdeck-agent

echo ""
echo "============================================================"
echo "  AtlasDeck - agente instalado e rodando"
echo "============================================================"
echo "  Hostname : $(hostname)"
echo "  Token    : $TOKEN"
echo ""
echo "  Copie o token acima e cadastre no AtlasDeck:"
echo "  ${publicUrl}/system   (aba VPS -> Adicionar VPS)"
echo "============================================================"
`;
}
