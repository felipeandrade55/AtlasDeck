import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { logActivity } from '@/lib/activities-db';

import { OPENCLAW_WORKSPACE, WORKSPACE_IDENTITY } from '@/lib/paths';
import { readOpenClawConfig } from '@/lib/openclaw-config';
import { hasWhatsappSessionLocal } from '@/lib/whatsapp-api';

const WORKSPACE_PATH = OPENCLAW_WORKSPACE;
const IDENTITY_PATH = WORKSPACE_IDENTITY;
const ENV_LOCAL_PATH = path.join(process.cwd(), '.env.local');

function parseIdentityMd(): { name: string; creature: string; emoji: string } {
  try {
    const content = fs.readFileSync(IDENTITY_PATH, 'utf-8');
    const nameMatch = content.match(/\*\*Name:\*\*\s*(.+)/);
    const creatureMatch = content.match(/\*\*Creature:\*\*\s*(.+)/);
    const emojiMatch = content.match(/\*\*Emoji:\*\*\s*(.+)/);
    
    return {
      name: nameMatch?.[1]?.trim() || 'Unknown',
      creature: creatureMatch?.[1]?.trim() || 'AI Agent',
      emoji: emojiMatch?.[1]?.match(/./u)?.[0] || '🤖',
    };
  } catch {
    return { name: 'OpenClaw Agent', creature: 'AI Agent', emoji: '🤖' };
  }
}

function getLastSessionTime(): string | null {
  try {
    const config = readOpenClawConfig();
    const raw = execFileSync(config.openclawBin, ['sessions', 'list', '--json'], {
      timeout: 4000,
      encoding: 'utf8',
      env: {
        ...process.env,
        OPENCLAW_DIR: config.openclawDir,
        OPENCLAW_WORKSPACE: config.openclawWorkspace,
      },
    }).toString().trim();
    if (!raw) return null;
    const payload = JSON.parse(raw);
    const sessions: Array<{ updatedAt: number }> = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.sessions)
        ? payload.sessions
        : [];
    if (!sessions.length) return null;
    const latest = sessions.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
    return new Date(latest.updatedAt).toISOString();
  } catch {
    return null;
  }
}

function getIntegrationStatus() {
  const integrations = [];
  const lastSessionTime = getLastSessionTime();

  // Telegram — read from openclaw.json (channels.telegram)
  let telegramEnabled = false;
  let telegramAccounts = 0;
  try {
    const openclawConfigPath = path.join(readOpenClawConfig().openclawDir, 'openclaw.json');
    const openclawConfig = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf-8'));
    const telegramConfig = openclawConfig?.channels?.telegram;
    telegramEnabled = !!(telegramConfig?.enabled);
    if (telegramConfig?.accounts) {
      telegramAccounts = Object.keys(telegramConfig.accounts).length;
    }
  } catch {}
  integrations.push({
    id: 'telegram',
    name: 'Telegram',
    status: telegramEnabled ? 'connected' : 'disconnected',
    icon: 'MessageCircle',
    lastActivity: telegramEnabled ? lastSessionTime : null,
    detail: telegramEnabled ? `${telegramAccounts} bots configured` : null,
  });

  // WhatsApp — read from openclaw.json (channels.whatsapp)
  let whatsappEnabled = false;
  let whatsappAccounts = 0;
  let whatsappConnected = false;
  try {
    const openclawConfigPath = path.join(readOpenClawConfig().openclawDir, 'openclaw.json');
    const openclawConfig = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf-8'));
    const whatsappConfig = openclawConfig?.channels?.whatsapp;
    whatsappEnabled = !!(whatsappConfig?.enabled);
    if (whatsappConfig?.accounts) {
      const accountIds = Object.keys(whatsappConfig.accounts);
      whatsappAccounts = accountIds.length;
      if (whatsappEnabled && whatsappAccounts > 0) {
        whatsappConnected = accountIds.some(id => {
          const acct = whatsappConfig.accounts[id];
          const token = typeof acct?.token === "string" ? acct.token.trim() : "";
          const hasToken = token.length > 0 && token !== "configured_mock_token";
          return hasWhatsappSessionLocal(id) || hasToken;
        });
      }
    }
  } catch {}
  integrations.push({
    id: 'whatsapp',
    name: 'WhatsApp',
    status: (whatsappEnabled && whatsappConnected) ? 'connected' : 'disconnected',
    icon: 'MessageSquare',
    lastActivity: whatsappEnabled ? lastSessionTime : null,
    detail: whatsappEnabled
      ? `${whatsappAccounts} contas configuradas (${whatsappConnected ? 'online' : 'desconectada'})`
      : null,
  });

  // Google (gog/google-gemini-cli-auth) — check openclaw.json plugins
  let googleConfigured = false;
  let googleDetail: string | null = null;
  try {
    const openclawConfigPath = path.join(readOpenClawConfig().openclawDir, 'openclaw.json');
    const openclawConfig = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf-8'));
    const gogPlugin = openclawConfig?.plugins?.entries?.['google-gemini-cli-auth'];
    googleConfigured = !!(gogPlugin?.enabled);
    if (googleConfigured) googleDetail = 'google-gemini-cli-auth plugin enabled';
  } catch {}
  // Fallback: check for gog config directory
  if (!googleConfigured) {
    try {
      const gogPath = path.join(os.homedir(), '.config', 'gog');
      googleConfigured = fs.existsSync(gogPath);
    } catch {}
  }
  integrations.push({
    id: 'google',
    name: 'Google (GOG)',
    status: googleConfigured ? 'configured' : 'not_configured',
    icon: 'Mail',
    lastActivity: null,
    detail: googleDetail,
  });

  return integrations;
}

export async function GET() {
  const identity = parseIdentityMd();
  const uptime = process.uptime();
  const nodeVersion = process.version;
  const model = process.env.OPENCLAW_MODEL || process.env.DEFAULT_MODEL || 'openai/gpt-5.4-codex';
  
  const systemInfo = {
    agent: {
      name: identity.name,
      creature: identity.creature,
      emoji: identity.emoji,
    },
    system: {
      uptime: Math.floor(uptime),
      uptimeFormatted: formatUptime(uptime),
      nodeVersion,
      model,
      workspacePath: WORKSPACE_PATH,
      platform: os.platform(),
      hostname: os.hostname(),
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem(),
      },
    },
    integrations: getIntegrationStatus(),
    timestamp: new Date().toISOString(),
  };
  
  return NextResponse.json(systemInfo);
}

export async function POST(request: Request) {
  try {
    const { action, data } = await request.json();
    
    if (action === 'change_password') {
      const { currentPassword, newPassword } = data;
      
      // Read current .env.local
      let envContent = '';
      try {
        envContent = fs.readFileSync(ENV_LOCAL_PATH, 'utf-8');
      } catch {
        return NextResponse.json({ error: 'Could not read configuration' }, { status: 500 });
      }
      
      // Verify current password
      const currentPassMatch = envContent.match(/AUTH_PASSWORD=(.+)/);
      const storedPassword = currentPassMatch?.[1]?.trim();
      
      if (storedPassword !== currentPassword) {
        logActivity('security', 'Tentativa de alteração de senha falhou', 'error', { metadata: { reason: 'incorrect_current_password' } });
        return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 });
      }
      
      // Update password
      const newEnvContent = envContent.replace(
        /AUTH_PASSWORD=.*/,
        `AUTH_PASSWORD=${newPassword}`
      );
      
      fs.writeFileSync(ENV_LOCAL_PATH, newEnvContent);
      logActivity('security', 'Senha de acesso alterada', 'success');
      
      return NextResponse.json({ success: true, message: 'Password updated successfully' });
    }
    
    if (action === 'clear_activity_log') {
      const activitiesPath = path.join(process.cwd(), 'data', 'activities.json');
      fs.writeFileSync(activitiesPath, '[]');
      logActivity('command', 'Registro de atividades limpo pelo usuário', 'success');
      return NextResponse.json({ success: true, message: 'Activity log cleared' });
    }
    
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch {
    return NextResponse.json({ error: 'Action failed' }, { status: 500 });
  }
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${Math.floor(seconds)}s`);
  
  return parts.join(' ');
}
