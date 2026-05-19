#!/usr/bin/env tsx
/**
 * Collect Usage Script
 *
 * Collects current OpenClaw usage deltas and stores them in SQLite.
 * Run manually or via cron.
 */

import path from "path";
import { collectUsage } from "../src/lib/usage-collector";

const DB_PATH = path.join(__dirname, "..", "data", "usage-tracking.db");

async function main() {
  console.log("Mission Control - Usage Collector");
  console.log(`Database: ${DB_PATH}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log();

  try {
    const result = await collectUsage(DB_PATH);
    console.log("Usage data collected successfully");
    console.log(`Source: ${result.source}`);
    console.log(`Sessions seen: ${result.sessionsSeen}`);
    console.log(`Deltas inserted: ${result.snapshotsInserted}`);
    console.log(`Tokens: ${result.totalTokens} (${result.inputTokens} input / ${result.outputTokens} output)`);
    console.log(`Cost: $${result.cost.toFixed(6)}`);
  } catch (error) {
    console.error("Error collecting usage data:", error);
    process.exit(1);
  }
}

main();
