import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";
import si from "systeminformation";

const execAsync = promisify(exec);

// Services monitored per backend
const SYSTEMD_SERVICES = ["mission-control"];
const PM2_SERVICES = ["classvault", "content-vault", "postiz-simple", "brain"];

interface ServiceEntry {
  name: string;
  status: string;
  description: string;
  backend: string;
  uptime?: number | null;
  restarts?: number;
  pid?: number | null;
  mem?: number | null;
  cpu?: number | null;
}

interface TailscaleDevice {
  hostname: string;
  ip: string;
  os: string;
  online: boolean;
}

interface FirewallRule {
  id: string;
  port: string;
  action: string;
  from: string;
  comment: string;
}

interface Fail2BanData {
  active: boolean;
  bannedIps: string[];
}

// Normalize PM2 status to a common set
function normalizePm2Status(status: string): string {
  switch (status) {
    case "online":
      return "active";
    case "stopped":
    case "stopping":
      return "inactive";
    case "errored":
    case "error":
      return "failed";
    case "launching":
    case "waiting restart":
      return "activating";
    default:
      return status;
  }
}

// Friendly display names for PM2 process names
const SERVICE_DESCRIPTIONS: Record<string, string> = {
  "mission-control": "Mission Control – AtlasDeck Dashboard",
  classvault: "ClassVault – LMS Platform",
  "content-vault": "Content Vault – Draft Management Webapp",
  "postiz-simple": "Postiz – Social Media Scheduler",
  brain: "Brain – Internal Tools",
  creatoros: "Creatoros Platform",
};

export async function GET() {
  try {
    const [cpuLoad, memInfo, fsInfo, netInfo, dockerInfo, tempInfo] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkStats(),
      si.dockerContainers().catch(() => []),
      si.cpuTemperature().catch(() => ({ main: 0 }))
    ]);

    // ── CPU ──────────────────────────────────────────────────────────────────
    const cpuUsage = Math.round(cpuLoad.currentLoad);
    const corePercents = cpuLoad.cpus.map(c => Math.round(c.load));
    const loadAvg = os.loadavg();

    // ── RAM ──────────────────────────────────────────────────────────────────
    const totalMem = memInfo.total;
    const usedMem = memInfo.active;
    const freeMem = memInfo.free;

    // ── Disk ─────────────────────────────────────────────────────────────────
    let diskTotal = 0;
    let diskUsed = 0;
    // We only sum up actual physical drives to avoid duplication
    for (const fs of fsInfo) {
      if (fs.type !== 'squashfs' && fs.type !== 'tmpfs' && fs.type !== 'devtmpfs') {
        diskTotal += fs.size;
        diskUsed += fs.used;
      }
    }
    const diskTotalGB = diskTotal / 1024 / 1024 / 1024;
    const diskUsedGB = diskUsed / 1024 / 1024 / 1024;
    const diskFreeGB = (diskTotal - diskUsed) / 1024 / 1024 / 1024;
    const diskPercent = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0;

    // ── Network ──────────────────────────────────────────────────────────────
    let rx = 0;
    let tx = 0;
    for (const net of netInfo) {
      if (net.iface !== 'lo') {
        rx += net.rx_sec || 0;
        tx += net.tx_sec || 0;
      }
    }
    const network = {
      rx: rx / 1024 / 1024,
      tx: tx / 1024 / 1024,
    };

    // ── Services ─────────────────────────────────────────────────────────────
    const services: ServiceEntry[] = [];

    // 1. Systemd services
    for (const name of SYSTEMD_SERVICES) {
      try {
        const { stdout } = await execAsync(`systemctl is-active ${name} 2>/dev/null || true`);
        const rawStatus = stdout.trim();
        services.push({
          name,
          status: rawStatus,
          description: SERVICE_DESCRIPTIONS[name] ?? name,
          backend: "systemd",
        });
      } catch {
        services.push({
          name,
          status: "unknown",
          description: SERVICE_DESCRIPTIONS[name] ?? name,
          backend: "systemd",
        });
      }
    }

    // 2. PM2 services
    try {
      const { stdout: pm2Json } = await execAsync("pm2 jlist 2>/dev/null");
      const pm2List = JSON.parse(pm2Json);
      const pm2Map: Record<string, any> = {};
      for (const proc of pm2List) {
        pm2Map[proc.name] = proc;
      }

      for (const name of PM2_SERVICES) {
        const proc = pm2Map[name];
        if (!proc) {
          services.push({
            name,
            status: "unknown",
            description: SERVICE_DESCRIPTIONS[name] ?? name,
            backend: "pm2",
          });
          continue;
        }

        const rawStatus = proc.pm2_env?.status ?? "unknown";
        const uptime =
          rawStatus === "online" && proc.pm2_env?.pm_uptime
            ? Date.now() - proc.pm2_env.pm_uptime
            : null;

        services.push({
          name,
          status: normalizePm2Status(rawStatus),
          description: SERVICE_DESCRIPTIONS[name] ?? name,
          backend: "pm2",
          uptime,
          restarts: proc.pm2_env?.restart_time ?? 0,
          pid: proc.pid,
          cpu: proc.pm2_env?.monit?.cpu ?? null,
          mem: proc.pm2_env?.monit?.memory ?? null,
        });
      }
    } catch (err) {
      console.error("Failed to query PM2:", err);
      for (const name of PM2_SERVICES) {
        services.push({
          name,
          status: "unknown",
          description: SERVICE_DESCRIPTIONS[name] ?? name,
          backend: "pm2",
        });
      }
    }

    // 3. Docker services
    if (Array.isArray(dockerInfo)) {
      for (const d of dockerInfo) {
        services.push({
          name: d.name,
          status: d.state === 'running' ? 'active' : d.state === 'exited' ? 'inactive' : 'failed',
          description: d.image,
          backend: "docker",
          uptime: d.startedAt ? Date.now() - new Date(Number(d.startedAt) * 1000).getTime() : null,
          restarts: 0,
        });
      }
    }

    // ── Tailscale VPN ─────────────────────────────────────────────────────────
    let tailscaleActive = false;
    let tailscaleBackendState = "NotInstalled";
    let tailscaleAuthUrl = "";
    let tailscaleIp = "";
    let tailscaleRxBytes = 0;
    let tailscaleTxBytes = 0;
    const tailscaleDevices: TailscaleDevice[] = [];
    try {
      const { stdout: tsJson } = await execAsync("tailscale status --json 2>/dev/null || echo '{}'");
      const tsData = JSON.parse(tsJson.trim() || "{}");
      tailscaleBackendState = tsData.BackendState || "NotInstalled";
      tailscaleAuthUrl = tsData.AuthURL || "";
      tailscaleActive = tailscaleBackendState === "Running";
      if (tsData.TailscaleIPs?.length > 0) {
        tailscaleIp = tsData.TailscaleIPs[0];
      }
      if (tsData.Self) {
        tailscaleRxBytes = tsData.Self.RxBytes || 0;
        tailscaleTxBytes = tsData.Self.TxBytes || 0;
      }
      if (tsData.Peer) {
        for (const peer of Object.values(tsData.Peer) as any[]) {
          tailscaleDevices.push({
            ip: peer.TailscaleIPs?.[0] || "",
            hostname: peer.HostName || "",
            os: peer.OS || "",
            online: peer.Online || peer.Active || false,
          });
        }
      }
    } catch (error) {
      console.error("Failed to get Tailscale status:", error);
    }

    // ── Firewall (UFW) ────────────────────────────────────────────────────────
    let firewallActive = false;
    const firewallRulesList: FirewallRule[] = [];

    try {
      const { stdout: ufwStatus } = await execAsync("ufw status numbered 2>/dev/null || true");
      if (ufwStatus.includes("Status: active")) {
        firewallActive = true;
        const lines = ufwStatus.split("\n");
        for (const line of lines) {
          const match = line.match(/\[\s*(\d+)\]\s+([\w/:]+)\s+(\w+)\s+(\S+)\s*(#?.*)$/);
          if (match) {
            firewallRulesList.push({
              id: match[1],
              port: match[2].trim(),
              action: match[3].trim(),
              from: match[4].trim(),
              comment: match[5].replace("#", "").trim(),
            });
          }
        }
      }
    } catch (error) {
      console.error("Failed to get firewall status:", error);
    }

    // ── Fail2Ban ──────────────────────────────────────────────────────────────
    let fail2banActive = false;
    let fail2banBanned: string[] = [];
    try {
      const { stdout: f2bPing } = await execAsync("fail2ban-client ping 2>/dev/null || true");
      if (f2bPing.includes("pong")) {
        fail2banActive = true;
        
        // Get list of jails
        const { stdout: f2bStatus } = await execAsync("fail2ban-client status 2>/dev/null || true");
        const jailsMatch = f2bStatus.match(/Jail list:\s+(.*)/);
        if (jailsMatch && jailsMatch[1]) {
          const jails = jailsMatch[1].split(',').map(j => j.trim()).filter(Boolean);
          
          for (const jail of jails) {
            const { stdout: jailStatus } = await execAsync(`fail2ban-client status ${jail} 2>/dev/null || true`);
            const bannedMatch = jailStatus.match(/Banned IP list:\s+(.*)/);
            if (bannedMatch && bannedMatch[1]) {
              const ips = bannedMatch[1].split(' ').map(ip => ip.trim()).filter(Boolean);
              fail2banBanned.push(...ips);
            }
          }
        }
      }
    } catch (error) {
      console.error("Failed to get Fail2Ban status:", error);
    }

    return NextResponse.json({
      cpu: {
        usage: cpuUsage,
        cores: corePercents,
        loadAvg,
        temperature: tempInfo?.main || 0
      },
      ram: {
        total: parseFloat(totalMem ? (totalMem / 1024 / 1024 / 1024).toFixed(2) : "0"),
        used: parseFloat(usedMem ? (usedMem / 1024 / 1024 / 1024).toFixed(2) : "0"),
        free: parseFloat(freeMem ? (freeMem / 1024 / 1024 / 1024).toFixed(2) : "0"),
        cached: 0,
      },
      disk: {
        total: parseFloat(diskTotalGB.toFixed(2)) || 100,
        used: parseFloat(diskUsedGB.toFixed(2)) || 0,
        free: parseFloat(diskFreeGB.toFixed(2)) || 100,
        percent: parseFloat(diskPercent.toFixed(2)) || 0,
      },
      network,
      systemd: services,
      tailscale: {
        active: tailscaleActive,
        backendState: tailscaleBackendState,
        authUrl: tailscaleAuthUrl,
        ip: tailscaleIp,
        devices: tailscaleDevices,
        rxBytes: tailscaleRxBytes,
        txBytes: tailscaleTxBytes,
      },
      firewall: {
        active: firewallActive,
        rules: firewallRulesList,
        ruleCount: firewallRulesList.length,
      },
      fail2ban: {
        active: fail2banActive,
        bannedIps: [...new Set(fail2banBanned)], // Deduplicate IPs
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching system monitor data:", error);
    return NextResponse.json(
      { error: "Failed to fetch system monitor data" },
      { status: 500 }
    );
  }
}
