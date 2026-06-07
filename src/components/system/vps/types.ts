// Client-side mirror of the host shape returned by /api/vps. Kept here so the
// VPS UI components don't import the server-only vps-db module (better-sqlite3).
export type HostStatus = 'pending' | 'online' | 'offline';

export interface ThresholdPair {
  warning: number;
  critical: number;
}

export interface VpsThresholds {
  cpu: ThresholdPair;
  ram: ThresholdPair;
  swap: ThresholdPair;
  disk: ThresholdPair;
  load1PerCore: ThresholdPair;
  offlineSec: number;
}

export interface MonitoredService {
  type: 'systemd' | 'docker';
  name: string;
}

export interface ProcessSnap {
  pid: number;
  name: string;
  cpu: number;
  memPct: number;
  cmd?: string;
}

export interface ServiceSnap {
  type: 'systemd' | 'docker';
  name: string;
  active: boolean;
  detail?: string;
}

export interface DiskSnap {
  mount: string;
  totalGb: number;
  usedGb: number;
  pct: number;
}

export interface ContainerSnap {
  id?: string;
  name: string;
  image?: string;
  state: string;
  status?: string;
  cpu?: number;
  memPct?: number;
  memMb?: number;
  restarts?: number;
}

export interface DockerSnap {
  installed: boolean;
  running?: boolean;
  containers?: ContainerSnap[];
}

export interface VpsSnapshot {
  reportedAtMs?: number;
  agentTs?: number;
  metrics?: Record<string, number>;
  processes?: ProcessSnap[];
  services?: ServiceSnap[];
  disks?: DiskSnap[];
  docker?: DockerSnap;
  loadAvg?: [number, number, number];
  uptimeSec?: number;
}

export interface VpsHost {
  vps_id: string;
  name: string;
  hostname: string | null;
  created_at: string;
  last_seen_ms: number | null;
  status: HostStatus;
  os: string | null;
  agent_version: string | null;
  thresholds: VpsThresholds;
  monitored_services: MonitoredService[];
  monitor_docker: boolean;
  last_snapshot: VpsSnapshot;
}

export function relativeTime(ms: number | null): string {
  if (!ms) return 'nunca';
  const diff = Date.now() - ms;
  if (diff < 0) return 'agora';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `há ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h}h`;
  const d = Math.floor(h / 24);
  return `há ${d}d`;
}

export function statusColor(status: HostStatus): string {
  if (status === 'online') return 'var(--success)';
  if (status === 'offline') return 'var(--error)';
  return 'var(--text-muted)';
}

export function statusLabel(status: HostStatus): string {
  if (status === 'online') return 'Online';
  if (status === 'offline') return 'Offline';
  return 'Aguardando';
}
