"use strict";
const path = require("path");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

/**
 * Tables managed outside Drizzle (via runStartupMigration in api-server).
 * Using glob negation ("*" + "!table") so drizzle ignores these tables
 * when comparing schema against the database — prevents spurious DROP INDEX
 * proposals in the Replit deploy migration warning.
 */
const STARTUP_MIGRATION_TABLES_EXCLUDE = [
  "!growth_leader_log",
  "!signal_pre_growth",
  "!whale_alert_pool",
  "!whale_alert_watch_log",
  "!whale_onchain_pool",
  "!pattern_debug_log",
  "!scan_reject_log",
  "!whale_event_tracking",
  "!periodic_collection_log",
  "!cg_liq_heatmap_snapshot",
  "!cg_netflow_snapshot",
  "!spot_ob_pool",
  "!retro_pre_growth",
  "!telegram_updates",
  "!prescan_history",
  "!prescan_snapshots",
  "!prescan_telemetry_outbox",
];

/** @type {import("drizzle-kit").Config} */
module.exports = {
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  tablesFilter: ["*", ...STARTUP_MIGRATION_TABLES_EXCLUDE],
};
