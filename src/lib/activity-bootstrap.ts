/**
 * Activity Bootstrap
 *
 * When the activity database is empty or nearly empty (e.g. fresh install),
 * synthesise a handful of real activities from the current system state so
 * the dashboard "Atividade Recente" never looks mocked/static.
 *
 * This runs once per process at startup (instrumentation.ts) and is
 * idempotent — it only seeds if there are < 3 real activities.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { logActivity, getActivityStats } from "./activities-db";
import { getSettings } from "./memory-db";
import { readOpenClawConfig } from "./openclaw-config";
import { WORKSPACE_IDENTITY } from "./paths";

let bootstrapped = false;

export async function bootstrapActivities(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;

  try {
    const stats = getActivityStats();
    // Only seed if the DB is essentially empty (fresh install / cleared log)
    if (stats.total >= 3) return;

    const now = new Date();
    const settings = getSettings();
    const identity = parseIdentity();

    // 1. System boot activity
    logActivity(
      "command",
      `Sistema iniciado: ${identity.name} online`,
      "success",
      {
        metadata: {
          platform: os.platform(),
          hostname: os.hostname(),
          nodeVersion: process.version,
        },
      }
    );

    // 2. Integrations status
    const integrations = getIntegrationStatus();
    for (const int of integrations) {
      if (int.status === "connected" || int.status === "configured") {
        logActivity(
          "config",
          `Integração ${int.name}: ${int.status}`,
          "success",
          { metadata: { detail: int.detail } }
        );
      }
    }

    // 3. Location if set
    if (settings.home_lat != null && settings.home_lon != null) {
      logActivity(
        "config",
        settings.home_label
          ? `Localização configurada: ${settings.home_label}`
          : `Localização configurada: ${settings.home_lat.toFixed(4)}, ${settings.home_lon.toFixed(4)}`,
        "success",
        { metadata: { lat: settings.home_lat, lon: settings.home_lon } }
      );
    }

    // 4. Cost settings if any limit is set
    try {
      const costDbPath = path.join(process.cwd(), "data", "usage-tracking.db");
      if (fs.existsSync(costDbPath)) {
        const usageQueries = await import("./usage-queries");
        const db = usageQueries.getDatabase(costDbPath);
        if (db) {
          try {
            const costSettings = usageQueries.getCostSettings(db);
            if (costSettings.limitUsd || costSettings.budget) {
              logActivity(
                "config",
                `Orçamento configurado: $${costSettings.limitUsd || costSettings.budget}/${costSettings.limitTimeframe || "monthly"}`,
                "success",
                { metadata: { alertThreshold: costSettings.alertThreshold, behaviorMode: costSettings.behaviorMode } }
              );
            }
          } finally {
            db.close();
          }
        }
      }
    } catch {
      // ignore — cost tracking might not be initialised yet
    }

    // 5. Memory MCP status
    try {
      const openclawDir = readOpenClawConfig().openclawDir;
      const openclawJsonPath = path.join(openclawDir, "openclaw.json");
      const openclawConfig = JSON.parse(fs.readFileSync(openclawJsonPath, "utf-8"));
      const mcpEntry = openclawConfig?.mcp?.servers?.["atlasdeck-memory"];
      if (mcpEntry) {
        logActivity(
          "memory",
          "Memória avançada (atlasdeck-memory MCP) detectada na configuração",
          "success",
          { metadata: { enabled: mcpEntry.enabled !== false } }
        );
      }
    } catch {
      // ignore
    }

    // 6. Recent backups
    try {
      const backupDir = path.join(process.cwd(), "data", "backups");
      if (fs.existsSync(backupDir)) {
        const backups = fs
          .readdirSync(backupDir)
          .filter((f) => f.endsWith(".tar.gz"))
          .map((f) => ({
            name: f,
            time: fs.statSync(path.join(backupDir, f)).mtime.getTime(),
          }))
          .sort((a, b) => b.time - a.time)
          .slice(0, 3);
        for (const b of backups) {
          logActivity(
            "backup",
            `Backup disponível: ${b.name}`,
            "success",
            { metadata: { date: new Date(b.time).toISOString() } }
          );
        }
      }
    } catch {
      // ignore
    }

    console.log(
      `[activity-bootstrap] Seeded ${getActivityStats().total - stats.total} activities from current system state`
    );
  } catch (err) {
    console.warn("[activity-bootstrap] failed:", err);
  }
}

function parseIdentity(): { name: string; creature: string; emoji: string } {
  try {
    const content = fs.readFileSync(WORKSPACE_IDENTITY, "utf-8");
    const nameMatch = content.match(/\*\*Name:\*\*\s*(.+)/);
    const creatureMatch = content.match(/\*\*Creature:\*\*\s*(.+)/);
    const emojiMatch = content.match(/\*\*Emoji:\*\*\s*(.+)/);
    return {
      name: nameMatch?.[1]?.trim() || "Unknown",
      creature: creatureMatch?.[1]?.trim() || "AI Agent",
      emoji: emojiMatch?.[1]?.match(/./u)?.[0] || "🤖",
    };
  } catch {
    return { name: "OpenClaw Agent", creature: "AI Agent", emoji: "🤖" };
  }
}

function getIntegrationStatus(): Array<{
  id: string;
  name: string;
  status: string;
  detail?: string | null;
}> {
  const integrations: Array<{
    id: string;
    name: string;
    status: string;
    detail?: string | null;
  }> = [];

  try {
    const openclawDir = readOpenClawConfig().openclawDir;
    const openclawConfig = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf-8")
    );

    // Telegram
    const telegramConfig = openclawConfig?.channels?.telegram;
    const telegramEnabled = !!(telegramConfig?.enabled);
    let telegramAccounts = 0;
    if (telegramConfig?.accounts) {
      telegramAccounts = Object.keys(telegramConfig.accounts).length;
    }
    integrations.push({
      id: "telegram",
      name: "Telegram",
      status: telegramEnabled ? "connected" : "disconnected",
      detail: telegramEnabled ? `${telegramAccounts} bots configurados` : null,
    });

    // WhatsApp
    const whatsappConfig = openclawConfig?.channels?.whatsapp;
    const whatsappEnabled = !!(whatsappConfig?.enabled);
    let whatsappAccounts = 0;
    if (whatsappConfig?.accounts) {
      whatsappAccounts = Object.keys(whatsappConfig.accounts).length;
    }
    integrations.push({
      id: "whatsapp",
      name: "WhatsApp",
      status: whatsappEnabled ? "connected" : "disconnected",
      detail: whatsappEnabled
        ? `${whatsappAccounts} contas configuradas`
        : null,
    });

    // Google
    let googleConfigured = false;
    let googleDetail: string | null = null;
    const gogPlugin = openclawConfig?.plugins?.entries?.["google-gemini-cli-auth"];
    googleConfigured = !!(gogPlugin?.enabled);
    if (googleConfigured) googleDetail = "google-gemini-cli-auth plugin enabled";
    if (!googleConfigured) {
      try {
        const gogPath = path.join(os.homedir(), ".config", "gog");
        googleConfigured = fs.existsSync(gogPath);
      } catch {}
    }
    integrations.push({
      id: "google",
      name: "Google (GOG)",
      status: googleConfigured ? "configured" : "not_configured",
      detail: googleDetail,
    });
  } catch {
    // ignore
  }

  return integrations;
}
