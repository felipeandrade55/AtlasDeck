#!/usr/bin/env node
/**
 * setup-email-store.cjs
 *
 * Idempotent bootstrap for AtlasDeck's local email store. Runs from
 * deploy.sh on every update + on fresh install so a brand-new VPS has
 * everything in place without manual setup:
 *
 *   - Creates data/email-accounts.json (empty schema) if missing.
 *   - Chmods to 600 (owner read/write only).
 *   - Validates JSON and repairs malformed structure (e.g. raw "{}" →
 *     "{ accounts: {} }") without losing existing account entries.
 *
 * Never throws. Soft-fails so a broken deploy never blocks on this.
 * CommonJS so deploy.sh can `node` it without ts-node.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(process.cwd(), "data", "email-accounts.json");

function safeChmod(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // ignore — Windows / non-owner filesystems
  }
}

function ensureStore() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });

    if (!fs.existsSync(STORE_PATH)) {
      fs.writeFileSync(STORE_PATH, JSON.stringify({ accounts: {} }, null, 2) + "\n", "utf-8");
      safeChmod(STORE_PATH);
      console.log("[email-store] criado " + STORE_PATH + " (vazio)");
      return;
    }

    // Already exists — validate and repair shape if needed.
    let raw;
    try {
      raw = fs.readFileSync(STORE_PATH, "utf-8");
    } catch (e) {
      console.warn("[email-store] não consegui ler " + STORE_PATH + ": " + e.message);
      return;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn(
        "[email-store] JSON inválido em " + STORE_PATH + " (" + e.message + ") — " +
          "fazendo backup e recriando vazio",
      );
      const backup = STORE_PATH + ".bak." + Date.now();
      try {
        fs.copyFileSync(STORE_PATH, backup);
      } catch {
        // ignore
      }
      fs.writeFileSync(STORE_PATH, JSON.stringify({ accounts: {} }, null, 2) + "\n", "utf-8");
      safeChmod(STORE_PATH);
      return;
    }

    let changed = false;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      parsed = { accounts: {} };
      changed = true;
    }
    if (!parsed.accounts || typeof parsed.accounts !== "object" || Array.isArray(parsed.accounts)) {
      parsed.accounts = {};
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(STORE_PATH, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
      console.log("[email-store] schema reparado em " + STORE_PATH);
    } else {
      console.log("[email-store] OK (" + Object.keys(parsed.accounts).length + " conta(s))");
    }
    safeChmod(STORE_PATH);
  } catch (err) {
    console.warn("[email-store] aviso: " + (err && err.message ? err.message : err));
  }
}

try {
  ensureStore();
  process.exit(0);
} catch (err) {
  console.error("[email-store] erro inesperado: " + (err && err.message ? err.message : err));
  // Soft-fail: never block a deploy.
  process.exit(0);
}
