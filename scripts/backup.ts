#!/usr/bin/env tsx
/**
 * Backup Script — Standalone
 *
 * Executa backup completo do OpenClaw + Dashboard.
 * Pode ser rodado manualmente ou via cron do sistema.
 *
 * Uso:
 *   npx tsx scripts/backup.ts
 */

import { runBackup } from "../src/lib/backup";

async function main() {
  console.log("============================================");
  console.log(" Mission Control — Backup Runner");
  console.log("============================================\n");

  const result = await runBackup();

  console.log("\n============================================");
  console.log(` Result: ${result.success ? "✅ SUCCESS" : "❌ FAILED"}`);
  console.log(` Archive: ${result.archivePath || "N/A"}`);
  console.log(` Log: ${result.logPath}`);
  console.log("============================================");

  process.exit(result.success ? 0 : 1);
}

main();
