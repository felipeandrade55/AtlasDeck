import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";
import { existsSync, readFileSync } from "fs";
import { getLastHealth } from "@/lib/health-monitor";
import { detectGatewayRuntime } from "@/lib/gateway-control";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";

const execAsync = promisify(exec);

const SYSTEMD_SERVICES = ["mission-control", "content-vault", "classvault", "creatoros"];

export async function GET() {
  try {
    // CPU (load average as percentage)
    const loadAvg = os.loadavg()[0];
    const cpuCount = os.cpus().length;
    const cpu = Math.min(Math.round((loadAvg / cpuCount) * 100), 100);

    // RAM
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const ram = {
      used: parseFloat((usedMem / 1024 / 1024 / 1024).toFixed(2)),
      total: parseFloat((totalMem / 1024 / 1024 / 1024).toFixed(2)),
    };

    // Disk
    let diskUsed = 0;
    let diskTotal = 100;
    try {
      const { stdout } = await execAsync("df -BG / | tail -1");
      const parts = stdout.trim().split(/\s+/);
      diskTotal = parseInt(parts[1].replace("G", ""));
      diskUsed = parseInt(parts[2].replace("G", ""));
    } catch (error) {
      console.error("Failed to get disk stats:", error);
    }

    // Systemd Services (count active ones)
    let activeServices = 0;
    let totalServices = SYSTEMD_SERVICES.length;
    try {
      for (const name of SYSTEMD_SERVICES) {
        const { stdout } = await execAsync(`systemctl is-active ${name} 2>/dev/null || true`);
        if (stdout.trim() === "active") activeServices++;
      }
    } catch (error) {
      console.error("Failed to get systemd stats:", error);
    }

    // Tailscale VPN Status
    let vpnActive = false;
    try {
      const { stdout } = await execAsync("tailscale status 2>/dev/null || true");
      vpnActive = stdout.trim().length > 0 && !stdout.includes("Tailscale is stopped");
    } catch {
      vpnActive = false;
    }

    // Firewall Status
    let firewallActive = false;
    try {
      const { stdout } = await execAsync("ufw status 2>/dev/null | head -1 || true");
      firewallActive = stdout.includes("active");
    } catch {
      firewallActive = false;
    }

    // Uptime
    const uptimeSeconds = os.uptime();
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const uptime = `${days}d ${hours}h`;

    // ─── GATEWAY & TELEGRAM ENRICHMENT ─────────────────────────────────────
    const health = getLastHealth();
    let gatewayActive = false;
    let gatewayRuntime = "unknown";
    let telegramEnabled = false;
    let telegramStatus = "unknown";
    let telegramDetail = "Não diagnosticado";
    let telegramBotName = "";
    let telegramPendingUpdates = 0;

    // Check local configuration
    try {
      const { path: configPath } = resolveOpenClawAgentsConfigPath();
      if (existsSync(configPath)) {
        const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
        telegramEnabled = !!cfg.channels?.telegram?.enabled;
      }
    } catch {}

    if (health) {
      const gwCheck = health.checks.find(c => c.id === "gateway");
      gatewayActive = gwCheck ? gwCheck.status === "pass" : false;
      
      const tgEnabledCheck = health.checks.find(c => c.id === "channel-enabled");
      telegramEnabled = tgEnabledCheck ? tgEnabledCheck.status === "pass" : telegramEnabled;

      // Find worst status among telegram checks
      const tgChecks = health.checks.filter(c => c.category === "telegram");
      if (tgChecks.length > 0) {
        const hasFail = tgChecks.some(c => c.status === "fail");
        const hasWarn = tgChecks.some(c => c.status === "warn");
        telegramStatus = hasFail ? "fail" : hasWarn ? "warn" : "pass";

        const botCheck = tgChecks.find(c => c.id.startsWith("bot-"));
        if (botCheck) {
          telegramBotName = botCheck.detail;
          telegramDetail = `Bot ativo: ${botCheck.detail}`;
        }
        
        const backlogCheck = tgChecks.find(c => c.id.startsWith("backlog-"));
        if (backlogCheck) {
          const match = backlogCheck.detail.match(/(\d+) updates/);
          if (match) telegramPendingUpdates = parseInt(match[1]);
        }
      } else {
        telegramStatus = telegramEnabled ? "pass" : "unknown";
        telegramDetail = telegramEnabled ? "Habilitado e saudável" : "Desabilitado";
      }

      // Read runtime from details
      if (gwCheck) {
        if (gwCheck.detail.includes("systemd")) gatewayRuntime = "systemd";
        else if (gwCheck.detail.includes("pm2")) gatewayRuntime = "pm2";
        else if (gwCheck.detail.includes("process")) gatewayRuntime = "process";
      }
    } else {
      // Fallback: fast active check
      try {
        const runtime = await detectGatewayRuntime();
        gatewayRuntime = runtime;
        gatewayActive = runtime !== "unknown";
      } catch {}
      telegramStatus = telegramEnabled ? "pass" : "unknown";
      telegramDetail = telegramEnabled ? "Configurado" : "Desativado";
    }

    return NextResponse.json({
      cpu,
      ram,
      disk: { used: diskUsed, total: diskTotal },
      vpnActive,
      firewallActive,
      activeServices,
      totalServices,
      uptime,
      gatewayActive,
      gatewayRuntime,
      telegramEnabled,
      telegramStatus,
      telegramDetail,
      telegramBotName,
      telegramPendingUpdates,
    });
  } catch (error) {
    console.error("Error fetching system stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch system stats" },
      { status: 500 }
    );
  }
}
