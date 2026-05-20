#!/bin/bash
# Calendar setup wrapper — runs the idempotent installer for the
# AtlasDeck ↔ OpenClaw integration. Safe to run multiple times.
#
# Usage:
#   ./scripts/setup-calendar.sh            # run install
#   ./scripts/setup-calendar.sh --status   # print status only
#
# Environment variables (optional):
#   OPENCLAW_DIR            default /root/.openclaw
#   ATLASDECK_BASE_URL      default http://localhost:3000
#   OPENCLAW_SERVICE_TOKEN  if absent, read from openclaw.json or generated

set -e
cd "$(dirname "$0")/.." || exit 1
npx tsx scripts/setup-calendar.ts "$@"
