/**
 * Alert engine for VPS monitoring. Shared by the ingest route (resource +
 * docker alerts) and the offline monitor (heartbeat alerts).
 *
 * Dedup is by state transition (same pattern as the cost alerts in
 * src/app/api/costs/route.ts): we compute the new level, compare it against
 * the persisted last_alert_state, and only fire when it changes — including a
 * recovery alert when it returns to none/ok. Every alert fans out to:
 *   - in-app notification (addNotification)
 *   - Telegram, DIRECT to the Bot API (sendTelegramAlert with empty creds →
 *     openclaw.json fallback; the OpenClaw gateway is never involved)
 *   - activity log (logActivity 'security')
 */
import { addNotification } from '@/lib/notifications';
import { sendTelegramAlert } from '@/lib/telegram';
import { logActivity } from '@/lib/activities-db';
import {
  getAlertState,
  setAlertState,
  type AlertLevel,
  type AlertState,
  type VpsHost,
} from '@/lib/vps-db';

export interface IngestSample {
  metrics?: Record<string, number>;
  processes?: Array<{ name: string; cpu: number; memPct: number }>;
  services?: Array<{ type: string; name: string; active: boolean; detail?: string }>;
  docker?: {
    installed: boolean;
    running?: boolean;
    containers?: Array<{ name: string; state: string }>;
  };
}

function levelFor(value: number, warn: number, crit: number): AlertLevel {
  if (value >= crit) return 'critical';
  if (value >= warn) return 'warning';
  return 'none';
}

function hostLink(host: VpsHost): string {
  return `/system?tab=vps&vps=${host.vps_id}`;
}

type EmitLevel = 'warning' | 'critical' | 'resolved';

async function emitAlert(
  host: VpsHost,
  opts: { level: EmitLevel; title: string; message: string; metadata?: Record<string, unknown> }
): Promise<void> {
  const { level, title, message, metadata } = opts;
  const notifType = level === 'critical' ? 'error' : level === 'warning' ? 'warning' : 'success';
  const tgIcon = level === 'critical' ? '🚨' : level === 'warning' ? '⚠️' : '✅';

  try {
    await addNotification(title, message, notifType, hostLink(host), {
      source: 'vps-monitor',
      vps_id: host.vps_id,
      ...metadata,
    });
  } catch (err) {
    console.warn('[vps-alerts] notification failed:', err);
  }

  try {
    const tgMessage = `<b>${tgIcon} AtlasDeck · ${escapeHtml(host.name)}</b>\n\n${escapeHtml(
      message
    )}`;
    await sendTelegramAlert('', '', tgMessage);
  } catch (err) {
    console.warn('[vps-alerts] telegram failed:', err);
  }

  try {
    logActivity('security', `[VPS ${host.name}] ${title}: ${message}`, level === 'resolved' ? 'success' : 'error', {
      metadata: { source: 'vps-monitor', vps_id: host.vps_id, level, ...metadata },
    });
  } catch {
    // best-effort
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const RESOURCE_LABELS: Record<string, string> = {
  cpu: 'CPU',
  ram: 'Memória RAM',
  swap: 'Swap',
  disk: 'Disco',
  load: 'Carga (load average)',
};

/**
 * Evaluate CPU/RAM/Swap/Disk/Load + per-process + docker against the host
 * thresholds and last_alert_state, firing only on transitions.
 */
export async function evaluateResourceAlerts(host: VpsHost, sample: IngestSample): Promise<void> {
  const state = getAlertState(host.vps_id);
  let changed = false;
  const m = sample.metrics || {};
  const t = host.thresholds;

  // ── Resource gauges ────────────────────────────────────────────────
  const gauges: Array<{ key: keyof AlertState; value: number | undefined; warn: number; crit: number; unit: string }> = [
    { key: 'cpu', value: m.cpu_usage, warn: t.cpu.warning, crit: t.cpu.critical, unit: '%' },
    { key: 'ram', value: m.ram_used_pct, warn: t.ram.warning, crit: t.ram.critical, unit: '%' },
    { key: 'swap', value: m.swap_used_pct, warn: t.swap.warning, crit: t.swap.critical, unit: '%' },
    { key: 'disk', value: m.disk_used_pct, warn: t.disk.warning, crit: t.disk.critical, unit: '%' },
    {
      key: 'load',
      value: m.load1_per_core,
      warn: t.load1PerCore.warning,
      crit: t.load1PerCore.critical,
      unit: '/core',
    },
  ];

  for (const g of gauges) {
    if (g.value == null || Number.isNaN(g.value)) continue;
    const newLevel = levelFor(g.value, g.warn, g.crit);
    const prev = state[g.key] as AlertLevel;
    if (newLevel === prev) continue;
    state[g.key] = newLevel as never;
    changed = true;
    const label = RESOURCE_LABELS[g.key as string];
    const valTxt = `${g.value.toFixed(g.unit === '/core' ? 2 : 1)}${g.unit}`;
    if (newLevel === 'none') {
      await emitAlert(host, {
        level: 'resolved',
        title: `${label} normalizado`,
        message: `${label} voltou ao normal (${valTxt}).`,
        metadata: { metric: g.key, value: g.value },
      });
    } else {
      await emitAlert(host, {
        level: newLevel,
        title: `${label} ${newLevel === 'critical' ? 'crítico' : 'alto'}`,
        message: `${label} em ${valTxt} (limite ${newLevel === 'critical' ? 'crítico' : 'de alerta'}).`,
        metadata: { metric: g.key, value: g.value },
      });
    }
  }

  // ── Top process consuming too much CPU ─────────────────────────────
  const topProc = (sample.processes || []).slice().sort((a, b) => b.cpu - a.cpu)[0];
  if (topProc) {
    const newLevel = levelFor(topProc.cpu, t.cpu.warning, t.cpu.critical);
    const prev = state.process;
    if (newLevel !== prev) {
      state.process = newLevel;
      changed = true;
      if (newLevel === 'none') {
        await emitAlert(host, {
          level: 'resolved',
          title: 'Processos normalizados',
          message: 'Nenhum processo está consumindo CPU acima do limite.',
          metadata: { metric: 'process' },
        });
      } else {
        await emitAlert(host, {
          level: newLevel,
          title: `Processo consumindo muito CPU`,
          message: `"${topProc.name}" está em ${topProc.cpu.toFixed(1)}% de CPU (mem ${topProc.memPct.toFixed(1)}%).`,
          metadata: { metric: 'process', process: topProc.name, cpu: topProc.cpu },
        });
      }
    }
  }

  // ── systemd services (manual list) ─────────────────────────────────
  if (sample.services && sample.services.length > 0) {
    for (const svc of sample.services) {
      const cur = svc.active ? 'ok' : 'down';
      const prev = state.service[svc.name];
      if (prev === undefined) {
        // baseline on first sight, no alert
        state.service[svc.name] = cur;
        changed = true;
        continue;
      }
      if (cur === prev) continue;
      state.service[svc.name] = cur;
      changed = true;
      if (cur === 'down') {
        await emitAlert(host, {
          level: 'critical',
          title: `Serviço caiu: ${svc.name}`,
          message: `O serviço ${svc.name} está inativo${svc.detail ? ` (${svc.detail})` : ''}.`,
          metadata: { service: svc.name },
        });
      } else {
        await emitAlert(host, {
          level: 'resolved',
          title: `Serviço recuperado: ${svc.name}`,
          message: `O serviço ${svc.name} voltou a ficar ativo.`,
          metadata: { service: svc.name },
        });
      }
    }
  }

  // ── Docker daemon + containers (auto-discovery) ────────────────────
  if (host.monitor_docker && sample.docker) {
    const dk = sample.docker;
    if (dk.installed) {
      const cur = dk.running ? 'ok' : 'down';
      if (cur !== state.docker) {
        state.docker = cur;
        changed = true;
        if (cur === 'down') {
          await emitAlert(host, {
            level: 'critical',
            title: 'Docker daemon caiu',
            message: 'O daemon do Docker não está respondendo neste VPS.',
            metadata: { docker: 'down' },
          });
        } else {
          await emitAlert(host, {
            level: 'resolved',
            title: 'Docker daemon recuperado',
            message: 'O daemon do Docker voltou a responder.',
            metadata: { docker: 'up' },
          });
        }
      }

      const containers = dk.containers || [];
      const seen = new Set<string>();
      for (const c of containers) {
        seen.add(c.name);
        const cur2 = c.state === 'running' ? 'running' : 'down';
        const prev = state.container[c.name];
        if (prev === undefined) {
          state.container[c.name] = cur2;
          changed = true;
          continue;
        }
        if (cur2 === prev) continue;
        state.container[c.name] = cur2;
        changed = true;
        if (cur2 === 'down') {
          await emitAlert(host, {
            level: 'critical',
            title: `Container parou: ${c.name}`,
            message: `O container Docker "${c.name}" está ${c.state}.`,
            metadata: { container: c.name, state: c.state },
          });
        } else {
          await emitAlert(host, {
            level: 'resolved',
            title: `Container recuperado: ${c.name}`,
            message: `O container Docker "${c.name}" voltou a rodar.`,
            metadata: { container: c.name },
          });
        }
      }
      // Containers that disappeared from the list were removed intentionally:
      // clear their state without alerting.
      for (const name of Object.keys(state.container)) {
        if (!seen.has(name)) {
          delete state.container[name];
          changed = true;
        }
      }
    }
  }

  if (changed) setAlertState(host.vps_id, state);
}

/** Heartbeat transition (online ↔ offline). Used by the offline monitor. */
export async function evaluateHeartbeat(host: VpsHost, isOnline: boolean): Promise<void> {
  const state = getAlertState(host.vps_id);
  const cur = isOnline ? 'online' : 'offline';
  if (cur === state.heartbeat) return;
  state.heartbeat = cur;
  setAlertState(host.vps_id, state);

  if (cur === 'offline') {
    const lastSeen = host.last_seen_ms
      ? new Date(host.last_seen_ms).toLocaleString('pt-BR')
      : 'desconhecido';
    await emitAlert(host, {
      level: 'critical',
      title: 'VPS offline',
      message: `O VPS ${host.name} parou de enviar dados (último contato: ${lastSeen}).`,
      metadata: { heartbeat: 'offline' },
    });
  } else {
    await emitAlert(host, {
      level: 'resolved',
      title: 'VPS online novamente',
      message: `O VPS ${host.name} voltou a enviar dados.`,
      metadata: { heartbeat: 'online' },
    });
  }
}
