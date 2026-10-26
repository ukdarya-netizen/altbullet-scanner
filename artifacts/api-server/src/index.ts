import {
  ensureStealthVerdictJournalSchema,
  runStealthCutoffOutcomeCycle,
} from "./lib/stealth-verdict-journal.js";
import {
  ensureTradingCommandOutboxSchema,
  startTradingCommandRelay,
} from "./lib/trading-command-outbox.js";
import {
  ensureStealthBreakoutCandleSnapshotsSchema,
  runStealthBreakoutCandleSnapshotCycle,
} from "./lib/stealth-breakout-candle-snapshots.js";
import { runStealthParticipationBackfillCycle } from "./lib/stealth-participation-backfill.js";
import { runEntryCandleAnalysisBackfillCycle } from "./lib/entry-candle-analysis-backfill.js";
import app from "./app";
import { logger } from "./lib/logger";
import { startProcessHealthSampler } from "./lib/process-health";
import {
  assertSchedulerLeaseSchema,
  isMarketCycleLeaseBusy,
  withSchedulerLease,
} from "./lib/schedulerLease.js";
import { runWhenMarketCycleIdle } from "./lib/market-job-guard.js";
import { runOptionalDbJob } from "./lib/optionalDbAdmission.js";
import {
  pool,
  db,
  settingsTable,
  subscribersTable,
  trackedSignalsTable,
} from "@workspace/db";
import {
  setWebhook,
  registerBotCommands,
  reconcilePendingSignalAlerts,
  warmChannelIdCache,
} from "./lib/telegram.js";
import {
  startScanner,
  stopScanner,
  getLastScanAt,
  getScannerActivityState,
  getDiscoveryScannerLeaseStatus,
  getScannerRecoveryState,
  getScannerDbAdmissionBlocker,
  setScannerWorkerRestartHandler,
  hydrateAutoRangeHistoryFromDb,
} from "./lib/scanner.js";
import {
  closeOverdueImpulseRunnersBeforeScanner,
  closeRequestedLossesBeforeScanner,
  reclassifyOpenExcludedSignalSymbols,
  startWatcher,
  startWatchdog,
} from "./lib/watcher.js";
import { repairImpulseRunnerCanonicalAccounting } from "./lib/impulse-runner-accounting-repair.js";
import { reclassifyReviewedStealthOneHourFailures } from "./lib/stealth-one-hour-reclassification.js";
import { reclassifyReviewedStealthInsideRangeEntry } from "./lib/stealth-cfx-inside-range-reclassification.js";
import { reclassifyOwnerReviewedInitNoBreakout } from "./lib/stealth-init-no-breakout-reclassification.js";
import { backfillOpenStealthBreakoutVolume } from "./lib/stealth-open-breakout-volume-backfill.js";
import { startRangeDeviationFollowup } from "./lib/range-deviation-followup.js";
import {
  backfillLc15mRange,
  backfillLcDetectionVolume,
  backfillOpenRangeDeviation,
} from "./lib/open-range-deviation-backfill.js";
import { neutralCloseReviewedLcPositions } from "./lib/lc-reviewed-neutral-close.js";
import { reclassifyReviewedOpenLiqCascadeSpikes } from "./lib/liq-cascade-open-reclassification.js";
import { moveReviewedNoObLcToWait } from "./lib/lc-no-ob-wait-migration.js";
import { neutralizeReviewedBalancedGrindDashboardSignals } from "./lib/balanced-grind-dashboard-close.js";
import { neutralizeReviewedImpulseBuySignals } from "./lib/impulse-buy-filter-neutral-close.js";
import { neutralizePlmP24hSignals } from "./lib/plm-p24h-neutral-close.js";
import { reclassifyPlmNegativeTrades } from "./lib/plm-negative-reclassification.js";
import { neutralizeOpenPlmSignals } from "./lib/plm-retirement-neutral-close.js";
import { neutralizeLegacyWhaleSignals } from "./lib/legacy-whale-neutral-close.js";
import { neutralizeReviewedStealthResistanceDashboardSignals } from "./lib/stealth-resistance-dashboard-close.js";
import {
  neutralizeOpOpenNeonPosition,
  restoreNeonRowsClosedByZoneRule,
} from "./lib/op-neon-neutral-close.js";
import { removeNeonOpenNoWaitPositions } from "./lib/neon-open-removal.js";
import { applyNeonNoWaitRecalc } from "./lib/neon-no-wait-recalc.js";
import { neutralizeNonAggregatedOpenPositions } from "./lib/non-aggregated-data-neutral-close.js";
import { neutralizeReviewedStealthVolumeGateSignals } from "./lib/stealth-volume-gate-neutral-close.js";
import { neutralizeNeonVolumeGateSignals } from "./lib/neon-volume-gate-neutral-close.js";
import { neutralizeOpenStealthSignals } from "./lib/stealth-open-neutral-close.js";
import { quarantineExpiredMilestoneRecipients } from "./lib/milestone-delivery-db.js";
import { ensureAltBulletSnapshotRetrySchema } from "./lib/altbullet-snapshot-schema.js";
import {
  ensureIndicatorTargetObservationsSchema,
  runIndicatorTargetObservationCycle,
} from "./lib/indicator-target-observations.js";
import { ensureLcStopBidSchema } from "./lib/lc-stop-bid-observations.js";
import { ensureLcObWaitSchema } from "./lib/lc-ob-wait-schema.js";
import {
  ensureLcWaitingShadowSchema,
  runLcWaitingShadowCycle,
} from "./lib/lc-waiting-shadow.js";
import {
  ensureLcRapidReboundSchema,
  runLcRapidReboundCycle,
} from "./lib/lc-rapid-rebound.js";
import {
  ensureProtectedCloseAuditSchema,
  startProtectedCloseAuditMonitor,
} from "./lib/protected-close-audit.js";
import { ensureBtcDominanceObservationsSchema } from "./lib/btc-dominance-observations.js";
import {
  ensureBtcCrossAlertsSchema,
  reconcileBtcCrossAlerts,
} from "./lib/btc-cross-alerts.js";
import { getBitcoinDominanceSummary } from "./lib/coinglass_btc_dominance.js";
import {
  logTelegramDeliveryHealth,
  quarantineAmbiguousTelegramRetries,
  quarantineDisabledStealthObservationDeliveries,
  quarantinePendingOperatorFailureAlerts,
  reconcileAmbiguousTelegramDeliveryAudit,
} from "./lib/telegram-photo-outbox.js";
import { refreshCgSupportedCoins } from "./lib/coinglass_oi.js";
import { ensureCoinglassCycleMetricsSchema } from "./lib/coinglass-cycle-metrics.js";
import { ensureCoinglassArmTraceSchema } from "./lib/coinglass-arm-trace.js";
import { ensureAutoRangeHistoryStoreSchema } from "./lib/auto-range-history-store.js";
import { refreshBinanceSpotListings } from "./lib/coinglass_listings.js";
import { startMarketCapPreloader } from "./lib/whale_watch_v2.js";
import { startExchangeListRefresher } from "./lib/coinglass-exchanges.js";
import { lt, sql as drizzleSql, eq, and } from "drizzle-orm";
import {
  collectBtcRegimeObservation,
  BTC_REGIME_LEASE,
} from "./lib/btc-regime.js";
import {
  ensureTradingSignalRelaySchema,
  startTradingSignalRelay,
} from "./lib/trading-signal-relay.js";

async function ensureBtcRegimeSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('btc_regime_observations_schema'))`,
    );
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS btc_regime_observations (
        id serial PRIMARY KEY,
        bucket_at timestamptz NOT NULL,
        observed_at timestamptz NOT NULL DEFAULT now(),
        price real,
        fetch_status text NOT NULL DEFAULT 'partial'
      )
    `);
    // Existing SNF/forward columns and historical values remain untouched;
    // new observations contain BTC price only.
    await tx.execute(
      drizzleSql`CREATE UNIQUE INDEX IF NOT EXISTS btc_regime_bucket_uniq ON btc_regime_observations (bucket_at)`,
    );
    await tx.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS btc_regime_bucket_desc_idx ON btc_regime_observations (bucket_at DESC)`,
    );
  });
}

/**
 * This outbox is a delivery safety boundary, not an optional analytics table:
 * watcher must not start before it is ready. Kept separate from the broad
 * startup migration because a failure in an unrelated ALTER must not disable
 * cancellation and position notifications.
 */
async function ensureTelegramPhotoOutboxSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('telegram_photo_deliveries_schema'))`,
    );
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS telegram_photo_deliveries (
        id              serial PRIMARY KEY,
        dedup_key       text NOT NULL,
        target          text NOT NULL,
        photo_path      text NOT NULL,
        caption         text NOT NULL,
        fallback_text   text NOT NULL,
        continuation_texts jsonb NOT NULL DEFAULT '[]'::jsonb,
        status          text NOT NULL DEFAULT 'ready',
        phase           text NOT NULL DEFAULT 'photo',
        next_part_index integer NOT NULL DEFAULT 0,
        next_attempt_at timestamp NOT NULL DEFAULT now(),
        lease_until     timestamp,
        claim_token     text,
        send_attempted_at timestamp,
        accepted_at     timestamp,
        delivered_at    timestamp,
        last_error      text,
        attempts        integer NOT NULL DEFAULT 0,
        photo_attempts  integer NOT NULL DEFAULT 0,
        plain_text      boolean NOT NULL DEFAULT false,
        ambiguous_retry_count integer NOT NULL DEFAULT 0,
        repeat_notice   boolean NOT NULL DEFAULT false,
        delivery_policy_version integer NOT NULL DEFAULT 1,
        created_at      timestamp NOT NULL DEFAULT now(),
        updated_at      timestamp NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS telegram_delivery_events (
        id                       serial PRIMARY KEY,
        event_key                text NOT NULL,
        expected_recipient_count integer NOT NULL,
        status                   text NOT NULL DEFAULT 'queued',
        last_error               text,
        completed_at             timestamp,
        attention_at             timestamp,
        created_at               timestamp NOT NULL DEFAULT now(),
        updated_at               timestamp NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS telegram_pattern_media_cache (
        media_key   text PRIMARY KEY,
        file_id     text,
        lease_until timestamp,
        claim_token text,
        upload_attempted_at timestamp,
        upload_event_key text,
        created_at  timestamp NOT NULL DEFAULT now(),
        updated_at  timestamp NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE telegram_photo_deliveries
      ADD COLUMN IF NOT EXISTS continuation_texts jsonb NOT NULL DEFAULT '[]'::jsonb
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE telegram_photo_deliveries
      ADD COLUMN IF NOT EXISTS next_part_index integer NOT NULL DEFAULT 0
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE telegram_photo_deliveries
      ADD COLUMN IF NOT EXISTS photo_attempts integer NOT NULL DEFAULT 0
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE telegram_photo_deliveries
      ADD COLUMN IF NOT EXISTS plain_text boolean NOT NULL DEFAULT false
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE telegram_photo_deliveries
      ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now()
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE telegram_photo_deliveries
      ADD COLUMN IF NOT EXISTS send_attempted_at timestamp
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE telegram_photo_deliveries
      ADD COLUMN IF NOT EXISTS accepted_at timestamp
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE telegram_photo_deliveries
      ADD COLUMN IF NOT EXISTS ambiguous_retry_count integer NOT NULL DEFAULT 0
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE telegram_photo_deliveries
      ADD COLUMN IF NOT EXISTS repeat_notice boolean NOT NULL DEFAULT false
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE telegram_photo_deliveries
      ADD COLUMN IF NOT EXISTS delivery_policy_version integer NOT NULL DEFAULT 1
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS telegram_delivery_attempt_audit (
        id                serial PRIMARY KEY,
        audit_key         text NOT NULL,
        delivery_id       integer NOT NULL,
        dedup_key         text NOT NULL,
        target            text NOT NULL,
        phase             text NOT NULL,
        part_index        integer NOT NULL,
        outcome           text NOT NULL,
        http_status       integer,
        classification    text NOT NULL DEFAULT 'unknown',
        retry_after_seconds integer,
        reason            text NOT NULL,
        attempt           integer NOT NULL DEFAULT 0,
        send_attempted_at timestamp,
        observed_at       timestamp NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE telegram_delivery_attempt_audit
      ADD COLUMN IF NOT EXISTS http_status integer
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE telegram_delivery_attempt_audit
      ADD COLUMN IF NOT EXISTS classification text NOT NULL DEFAULT 'unknown'
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE telegram_delivery_attempt_audit
      ADD COLUMN IF NOT EXISTS retry_after_seconds integer
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS telegram_delivery_rate_limits (
        bucket_key      text PRIMARY KEY,
        next_allowed_at timestamp NOT NULL DEFAULT now(),
        updated_at      timestamp NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS telegram_photo_delivery_dedup_target_unique
      ON telegram_photo_deliveries (dedup_key, target)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS telegram_photo_delivery_due_idx
      ON telegram_photo_deliveries (status, next_attempt_at, lease_until)
    `);
    await tx.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS telegram_delivery_event_key_unique
      ON telegram_delivery_events (event_key)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS telegram_delivery_event_status_idx
      ON telegram_delivery_events (status, updated_at)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS telegram_pattern_media_cache_lease_idx
      ON telegram_pattern_media_cache (lease_until)
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE telegram_pattern_media_cache
      ADD COLUMN IF NOT EXISTS upload_attempted_at timestamp
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE telegram_pattern_media_cache
      ADD COLUMN IF NOT EXISTS upload_event_key text
    `);
    await tx.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS telegram_delivery_attempt_audit_key_unique
      ON telegram_delivery_attempt_audit (audit_key)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS telegram_delivery_attempt_audit_observed_idx
      ON telegram_delivery_attempt_audit (observed_at)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS telegram_delivery_attempt_audit_delivery_idx
      ON telegram_delivery_attempt_audit (delivery_id)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS telegram_delivery_rate_limits_due_idx
      ON telegram_delivery_rate_limits (next_allowed_at)
    `);
  });
}

/**
 * Scanner recovery state is part of the operational safety boundary: without
 * it a second worker can only emit a generic "not scanning" watchdog alert.
 * Keep this gate separate from optional startup maintenance so production
 * deploys always receive the columns before the scanner starts.
 */
/**
 * Trailing-hit diagnostics are written on the terminal protection path. Keep
 * their minimum schema outside the optional broad startup migration so a normal
 * deploy cannot silently lose the price source for a realtime exit.
 */
async function ensureTrailingAnalyticsSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('signal_trailing_events_schema'))`,
    );
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS signal_trailing_events (
        id                       serial PRIMARY KEY,
        signal_id                integer NOT NULL,
        symbol                   text NOT NULL,
        sentiment_key            text NOT NULL,
        event_type               text NOT NULL,
        is_short                 boolean NOT NULL DEFAULT false,
        activation_pct           real NOT NULL,
        trailing_gap_pct         real NOT NULL,
        observed_at              timestamptz NOT NULL,
        peak_price               real NOT NULL,
        peak_pnl_pct             real NOT NULL,
        current_price            real NOT NULL,
        current_pnl_pct          real NOT NULL,
        trailing_stop_price      real NOT NULL,
        theoretical_exit_pnl_pct real NOT NULL,
        actual_status            text,
        actual_exit_price        real,
        actual_pnl_pct           real,
        closed_at                timestamptz,
        latency_ms               bigint,
        price_source             text NOT NULL DEFAULT 'fast_cycle'
      )
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE signal_trailing_events
        ADD COLUMN IF NOT EXISTS price_source text NOT NULL DEFAULT 'fast_cycle'
    `);
    await tx.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS signal_trailing_events_signal_type_uniq
        ON signal_trailing_events (signal_id, event_type)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_trailing_events_pattern_idx
        ON signal_trailing_events (sentiment_key)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_trailing_events_observed_at_idx
        ON signal_trailing_events (observed_at)
    `);
  });
}

/**
 * Close-time BTC context is written by both the fast-cycle and realtime
 * trailing closure paths. Keep this additive migration in the mandatory
 * position-tracking gate so neither development nor production can start a
 * watcher against a schema that cannot persist a terminal update.
 */
async function ensurePositionTrackingSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('position_tracking_schema'))`,
    );
    // Fire-time aggregated OI Δ15m is part of every tracked-signal INSERT.
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_oi_15m real`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS close_btc_24h real`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_btc_24h real`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_btc_price real`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS close_btc_price real`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_btc_dominance real`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_btc_dominance_source text`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_btc_dominance_observed_at timestamp`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS close_btc_dominance real`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS close_btc_dominance_source text`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS close_btc_dominance_observed_at timestamp`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS trailing_stop_armed_at timestamp`,
    );
    // Frozen impulse runner policy state. Nullable fields deliberately leave
    // legacy rows and legacy open positions on their existing exit behavior.
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS policy_version text`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_policy_version text`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS runner_state text`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS core_closed_at timestamp`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS core_exit_price real`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS core_pnl_percent real`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS core_close_event_key text`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS runner_peak_price real`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS runner_trailing_stop_level real`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS runner_trailing_stop_armed_at timestamp`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS runner_exit_price real`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS runner_pnl_percent real`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS runner_closed_at timestamp`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS runner_close_event_key text`,
    );
    // Drizzle selects every tracker column in watcher cycles. These decision
    // payloads must exist before the watcher starts, not only in the later
    // compatibility migration.
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS impulse_decision_metrics jsonb`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS decision_metrics jsonb`,
    );
    await tx.execute(
      drizzleSql`CREATE UNIQUE INDEX IF NOT EXISTS tracked_signals_core_close_event_key_idx ON tracked_signals (core_close_event_key) WHERE core_close_event_key IS NOT NULL`,
    );
    await tx.execute(
      drizzleSql`CREATE UNIQUE INDEX IF NOT EXISTS tracked_signals_runner_close_event_key_idx ON tracked_signals (runner_close_event_key) WHERE runner_close_event_key IS NOT NULL`,
    );
    // Detector provenance is additive and intentionally nullable: historical
    // rows must remain unknown rather than being reclassified heuristically.
    await tx.execute(
      drizzleSql`ALTER TABLE signals ADD COLUMN IF NOT EXISTS stealth_detection_method text`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS stealth_detection_method text`,
    );
    // Tracker and source signal are two views of the same immutable fire event.
    // Copy only exact tracker-linked provenance; never infer a method for legacy
    // rows where neither side recorded one.
    await tx.execute(drizzleSql`
      UPDATE signals AS s
         SET stealth_detection_method = ts.stealth_detection_method
        FROM tracked_signals AS ts
       WHERE ts.signal_id = s.id
         AND ts.sentiment_key = 'stealth_breakout'
         AND ts.stealth_detection_method IS NOT NULL
         AND s.stealth_detection_method IS NULL
    `);
    await tx.execute(drizzleSql`
      UPDATE tracked_signals
      SET trailing_stop_armed_at = updated_at
      WHERE trailing_stop_level IS NOT NULL
        AND trailing_stop_armed_at IS NULL
    `);
  });
}

/**
 * Reconcile obsolete weighted accounting and stale runner exits written below
 * an already-earned trailing floor. This is deliberately price-derived (never
 * a row-specific claimed percentage) and idempotent, so every production boot
 * can safely run it.
 */

/** Mandatory gate: the scanner reject-log insert writes the Neon zone columns. */
async function ensureScanRejectZoneColumns(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('scan_reject_zone_columns'))`,
    );
    await tx.execute(
      drizzleSql`CREATE TABLE IF NOT EXISTS scan_reject_log (
        id serial PRIMARY KEY,
        cycle_at timestamptz NOT NULL,
        symbol text NOT NULL,
        pattern text NOT NULL,
        reason text NOT NULL,
        oi30m real,
        vol_mult real,
        price24h real,
        prescan_cycles integer
      )`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE scan_reject_log ADD COLUMN IF NOT EXISTS zone_bottom real, ADD COLUMN IF NOT EXISTS zone_top real`,
    );
  });
}

/** Mandatory gate for the retired re-entry detector's immutable observations. */
async function ensureReentryShadowSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('reentry_shadow_schema'))`,
    );
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS reentry_shadow_events (
        id serial PRIMARY KEY,
        tracked_signal_id integer NOT NULL,
        event_key text NOT NULL,
        source text NOT NULL,
        detector_version text NOT NULL,
        symbol text NOT NULL,
        pattern text NOT NULL,
        candidate_at timestamptz NOT NULL,
        proposed_reentry_price real NOT NULL,
        original_entry_price real NOT NULL,
        current_pnl_pct real,
        volume_multiplier real,
        spot_volume_multiplier real,
        oi_evidence real,
        cvd_evidence text,
        context text,
        outcome_4h_pct real,
        outcome_4h_observed_at timestamptz,
        outcome_8h_pct real,
        outcome_8h_observed_at timestamptz,
        outcome_24h_pct real,
        outcome_24h_observed_at timestamptz
      )
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE reentry_shadow_events
        ADD COLUMN IF NOT EXISTS event_key text,
        ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'watcher',
        ADD COLUMN IF NOT EXISTS detector_version text NOT NULL DEFAULT 'reentry_shadow_v1'
    `);
    await tx.execute(drizzleSql`
      UPDATE reentry_shadow_events
      SET event_key = 'legacy:' || tracked_signal_id || ':' || extract(epoch from candidate_at)::bigint
      WHERE event_key IS NULL
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE reentry_shadow_events ALTER COLUMN event_key SET NOT NULL
    `);
    await tx.execute(drizzleSql`
      DROP INDEX IF EXISTS reentry_shadow_signal_candidate_uniq
    `);
    await tx.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS reentry_shadow_event_key_uniq
        ON reentry_shadow_events (event_key)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS reentry_shadow_candidate_at_idx
        ON reentry_shadow_events (candidate_at)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS reentry_shadow_pattern_idx
        ON reentry_shadow_events (pattern)
    `);
  });
}

async function ensureScannerRecoverySchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('scanner_recovery_schema'))`,
    );
    // Scanner status is part of the owner dashboard and liveness boundary.
    // These fields cannot depend on RUN_STARTUP_MAINTENANCE: a missing optional
    // duration column previously made the whole /api/scanner/status response
    // fail and hid every API indicator.
    await tx.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_last_scan_at TIMESTAMP`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_scan_started_at TIMESTAMP`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_last_scan_duration_ms INTEGER`,
    );
    await tx.execute(drizzleSql`
      UPDATE settings
      SET scanner_last_scan_duration_ms = GREATEST(
        0,
        (EXTRACT(EPOCH FROM (scanner_last_scan_at - scanner_scan_started_at)) * 1000)::INTEGER
      )
      WHERE scanner_last_scan_duration_ms IS NULL
        AND scanner_last_scan_at IS NOT NULL
        AND scanner_scan_started_at IS NOT NULL
        AND scanner_last_scan_at >= scanner_scan_started_at
    `);
    await tx.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_failure_at TIMESTAMP`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_failure_reason TEXT`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_failure_diagnostics_json TEXT`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_lease_expected_expiry_at TIMESTAMP`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_last_failure_at TIMESTAMP`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_last_failure_reason TEXT`,
    );
    await tx.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_retry_at TIMESTAMP`,
    );
  });
}

/**
 * Milestone recipient rows are a mandatory delivery ledger. Keep their schema
 * gate independent from broad startup maintenance so a deploy can safely
 * recover an interrupted channel notification before the watcher starts.
 */
async function ensureMilestoneDeliverySchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('milestone_notification_deliveries_schema'))`,
    );
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS milestone_notification_deliveries (
        id                serial PRIMARY KEY,
        tracked_signal_id integer NOT NULL,
        milestone         integer NOT NULL,
        milestone_kind    text NOT NULL,
        target            text NOT NULL,
        status            text NOT NULL DEFAULT 'ready',
        lease_until       timestamp,
        claim_token       text,
        delivered_at      timestamp,
        last_error        text,
        attempts          integer NOT NULL DEFAULT 0,
        created_at        timestamp NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE milestone_notification_deliveries
      ADD COLUMN IF NOT EXISTS claim_token text
    `);
    await tx.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS milestone_notification_delivery_unique
      ON milestone_notification_deliveries
        (tracked_signal_id, milestone_kind, milestone, target)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS milestone_notification_delivery_state_idx
      ON milestone_notification_deliveries (status, lease_until)
    `);
  });
}

/**
 * Presence is an optional dashboard feature, but its lightweight schema change
 * must not wait for heavy startup maintenance to run in production.
 */
async function ensureDashboardPresenceSchema(): Promise<void> {
  await db.execute(drizzleSql`
    ALTER TABLE dashboard_users
    ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP
  `);
}

/**
 * Health and cancellation outcome rows are read by owner-only dashboard
 * routes. Their schema must be available in development as well as production;
 * keeping it behind optional heavy maintenance makes both pages return 500 on
 * a fresh dev database.
 */
async function ensureHealthOutcomesSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('health_outcomes_schema'))`,
    );
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS signal_health_events (
        id              serial PRIMARY KEY,
        signal_id       integer NOT NULL,
        symbol          text NOT NULL,
        sentiment_key   text NOT NULL,
        message_type    text NOT NULL,
        pnl_at_send     real,
        oi_30m          real,
        turnover        real,
        cvd_15m         boolean,
        cvd_30m         boolean,
        cvd_1h          boolean,
        price_at_send   real,
        entry_price     real,
        sent_at         timestamp NOT NULL DEFAULT now(),
        observed_4h_at  timestamp,
        observed_8h_at  timestamp,
        observed_24h_at timestamp,
        price_4h_pct    real,
        price_8h_pct    real,
        price_24h_pct   real,
        delivery_status text NOT NULL DEFAULT 'delivered',
        observation_source text NOT NULL DEFAULT 'telegram',
        baseline_state text,
        raw_state text,
        price_prior_1h_pct real,
        price_prior_4h_pct real,
        reference_1h_at timestamp,
        reference_4h_at timestamp,
        shadow_reason text
      )
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE signal_health_events
        ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'delivered'
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE signal_health_events
        ADD COLUMN IF NOT EXISTS observation_source text NOT NULL DEFAULT 'telegram'
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE signal_health_events
        ADD COLUMN IF NOT EXISTS baseline_state text,
        ADD COLUMN IF NOT EXISTS raw_state text,
        ADD COLUMN IF NOT EXISTS price_prior_1h_pct real,
        ADD COLUMN IF NOT EXISTS price_prior_4h_pct real,
        ADD COLUMN IF NOT EXISTS reference_1h_at timestamp,
        ADD COLUMN IF NOT EXISTS reference_4h_at timestamp,
        ADD COLUMN IF NOT EXISTS shadow_reason text
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_health_events_signal_idx
        ON signal_health_events (signal_id)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_health_events_sent_at_idx
        ON signal_health_events (sent_at DESC)
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS signal_cancel_outcomes (
        id              serial PRIMARY KEY,
        signal_id       integer NOT NULL,
        symbol          text NOT NULL,
        sentiment_key   text NOT NULL,
        cancel_reason   text NOT NULL,
        pnl_at_cancel   real,
        price_at_cancel real,
        entry_price     real,
        sent_at         timestamp NOT NULL DEFAULT now(),
        observed_4h_at  timestamp,
        observed_8h_at  timestamp,
        observed_24h_at timestamp,
        price_4h_pct    real,
        price_8h_pct    real,
        price_24h_pct   real
      )
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_cancel_outcomes_signal_idx
        ON signal_cancel_outcomes (signal_id)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_cancel_outcomes_sent_at_idx
        ON signal_cancel_outcomes (sent_at DESC)
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS cancel_outcome_weekly_snapshots (
        id                serial PRIMARY KEY,
        snapshot_week     date NOT NULL,
        cancel_reason     text NOT NULL,
        total             integer NOT NULL DEFAULT 0,
        observed          integer NOT NULL DEFAULT 0,
        false_cancels     integer NOT NULL DEFAULT 0,
        false_cancel_rate real,
        avg_pnl           real,
        avg_p24h          real,
        created_at        timestamp NOT NULL DEFAULT now(),
        UNIQUE (snapshot_week, cancel_reason)
      )
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS cancel_outcome_weekly_snapshots_week_idx
        ON cancel_outcome_weekly_snapshots (snapshot_week DESC)
    `);
  });
}

async function ensureImpulseBuyShadowSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('impulse_buy_shadow_schema'))`,
    );
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS missed_signals_log (
        id                    serial PRIMARY KEY,
        symbol                text NOT NULL,
        source                text NOT NULL,
        reason                text NOT NULL,
        pattern               text,
        price_at_log          real,
        price_24h_pct         real,
        oi_30m_pct            real,
        oi_1h_pct             real,
        oi_4h_pct             real,
        vol_mult              real,
        spot_vol_mult         real,
        cvd_30m               boolean,
        cvd_1h                boolean,
        cvd_4h                boolean,
        prescan_cycles        integer,
        logged_at             timestamp NOT NULL DEFAULT now(),
        price_6h_pct          real,
        price_24h_pct_after   real,
        gap_details           text,
        decision_score        integer,
        decision_metrics_json jsonb
      )
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE missed_signals_log
      ADD COLUMN IF NOT EXISTS decision_score integer
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE missed_signals_log
      ADD COLUMN IF NOT EXISTS decision_metrics_json jsonb
    `);
  });
}

/**
 * Breakout classification and its early TA observations must remain available
 * after a worker restart, independently of the trading signal lifecycle.
 */
async function ensureBreakoutAnalysisSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('breakout_analysis_schema'))`,
    );
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS breakout_analysis_snapshots (
        id               serial PRIMARY KEY,
        symbol           text NOT NULL,
        candidate_source text NOT NULL,
        price            real,
        price_24h        real,
        cycle_count      integer,
        layers           text[] NOT NULL DEFAULT '{}',
        evidence         jsonb NOT NULL,
        analyzed_at      timestamp NOT NULL DEFAULT now(),
        capture_window   timestamp NOT NULL,
        UNIQUE (symbol, candidate_source, capture_window)
      )
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS breakout_analysis_snapshots_symbol_time_idx
        ON breakout_analysis_snapshots (symbol, analyzed_at DESC)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS breakout_analysis_snapshots_time_idx
        ON breakout_analysis_snapshots (analyzed_at DESC)
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE signals
        ADD COLUMN IF NOT EXISTS stealth_range_confirming_venues jsonb,
        ADD COLUMN IF NOT EXISTS stealth_range_lifecycle_key text
    `);
    await tx.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS signals_stealth_range_lifecycle_unique
        ON signals (stealth_range_lifecycle_key)
        WHERE stealth_range_lifecycle_key IS NOT NULL
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS stealth_breakout_observations (
        id                    serial PRIMARY KEY,
        symbol                text NOT NULL,
        observation_key       text NOT NULL,
        level_key             text NOT NULL,
        breakout_source       text NOT NULL,
        breakout_level        real NOT NULL,
        touches               integer NOT NULL,
        quiet_zone            boolean NOT NULL,
        first_cross_at        timestamp NOT NULL,
        first_detected_at     timestamp NOT NULL,
        confirmation_at       timestamp,
        confirmation_signal_id integer,
        early_alert_queued    boolean NOT NULL DEFAULT false,
        created_at            timestamp NOT NULL DEFAULT now(),
        updated_at            timestamp NOT NULL DEFAULT now(),
        UNIQUE (observation_key)
      )
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS stealth_breakout_observation_symbol_time_idx
        ON stealth_breakout_observations (symbol, first_cross_at)
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS stealth_breakout_armed_setups (
        id                       serial PRIMARY KEY,
        symbol                   text NOT NULL,
        structure_key            text NOT NULL,
        breakout_source          text NOT NULL,
        breakout_level           double precision NOT NULL,
        touches                  integer NOT NULL,
        quiet_zone               boolean NOT NULL DEFAULT true,
        armed_at                 timestamptz NOT NULL,
         armed_after_1h_at        timestamptz,
         armed_after_4h_at        timestamptz,
        expires_at               timestamptz NOT NULL,
        status                   text NOT NULL DEFAULT 'armed',
        first_cross_at           timestamptz,
        terminal_reason          text,
        fired_at                 timestamptz,
        structure_json           jsonb NOT NULL,
        decision_json            jsonb,
        decision_at              timestamptz,
        trigger_candle_at        timestamptz,
        decision_lag_ms          bigint,
        fire_claimed_at          timestamptz,
         fired_signal_id          integer REFERENCES signals(id),
         abneon_indicator_version text,
         abneon_status            text,
         abneon_verdict           text,
         abneon_nearest_resistance double precision,
         abneon_level_distance_pct double precision,
         abneon_classification    text,
         abneon_coverage          text,
         abneon_reason            text,
         abneon_checks            jsonb,
         abneon_context           jsonb,
         abneon_captured_at       timestamptz,
         level_source             text NOT NULL DEFAULT 'stealth_legacy',
         legacy_breakout_level    double precision,
         experiment_version       text,
        created_at               timestamptz NOT NULL DEFAULT now(),
        updated_at               timestamptz NOT NULL DEFAULT now(),
        UNIQUE (symbol, structure_key)
      )
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS stealth_abneon_shadow_candidates (
        id serial PRIMARY KEY,
        symbol text NOT NULL,
        detection_method text NOT NULL,
        candidate_key text NOT NULL,
        frozen_level double precision NOT NULL,
        armed_at timestamptz NOT NULL,
        trigger_candle_at timestamptz,
        status text NOT NULL DEFAULT 'armed',
         live_eligible boolean NOT NULL DEFAULT false,
        terminal_reason text,
        volume_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (symbol, detection_method, candidate_key)
      )
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS stealth_abneon_shadow_evaluations (
        id bigserial PRIMARY KEY,
        symbol text NOT NULL,
        detection_method text NOT NULL,
        candidate_key text NOT NULL,
        observed_at timestamptz NOT NULL,
        status text NOT NULL,
        reason text,
        metrics jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS stealth_abneon_shadow_evaluations_cand_idx
      ON stealth_abneon_shadow_evaluations (symbol, detection_method, candidate_key, observed_at)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS stealth_abneon_shadow_candidates_active_idx
      ON stealth_abneon_shadow_candidates (symbol, detection_method, status)
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE stealth_abneon_shadow_candidates
        ADD COLUMN IF NOT EXISTS live_eligible boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS fire_claim_owner text,
        ADD COLUMN IF NOT EXISTS fire_claim_token text,
        ADD COLUMN IF NOT EXISTS fire_claim_expires_at timestamptz
    `);
    await tx.execute(drizzleSql`
      UPDATE stealth_abneon_shadow_candidates
         SET live_eligible = false
       WHERE live_eligible IS NULL
    `);
    // Order-block support is shadow-only by contract. Repair any row written
    // by an older worker before it can enter the Neon delivery queue.
    await tx.execute(drizzleSql`
      UPDATE stealth_abneon_shadow_candidates
         SET live_eligible = false
       WHERE detection_method = 'order_block_support_bounce'
         AND live_eligible IS DISTINCT FROM false
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE stealth_abneon_shadow_candidates
        ALTER COLUMN live_eligible SET DEFAULT false,
        ALTER COLUMN live_eligible SET NOT NULL
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE stealth_breakout_armed_setups
         ALTER COLUMN armed_after_1h_at DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS decision_json jsonb,
        ADD COLUMN IF NOT EXISTS decision_at timestamptz,
        ADD COLUMN IF NOT EXISTS trigger_candle_at timestamptz,
        ADD COLUMN IF NOT EXISTS decision_lag_ms bigint,
         ADD COLUMN IF NOT EXISTS fire_claimed_at timestamptz,
         ADD COLUMN IF NOT EXISTS fired_signal_id integer REFERENCES signals(id),
         ADD COLUMN IF NOT EXISTS abneon_indicator_version text,
         ADD COLUMN IF NOT EXISTS abneon_status text,
         ADD COLUMN IF NOT EXISTS abneon_verdict text,
         ADD COLUMN IF NOT EXISTS abneon_nearest_resistance double precision,
         ADD COLUMN IF NOT EXISTS abneon_level_distance_pct double precision,
         ADD COLUMN IF NOT EXISTS abneon_classification text,
         ADD COLUMN IF NOT EXISTS abneon_coverage text,
         ADD COLUMN IF NOT EXISTS abneon_reason text,
         ADD COLUMN IF NOT EXISTS abneon_checks jsonb,
         ADD COLUMN IF NOT EXISTS abneon_context jsonb,
         ADD COLUMN IF NOT EXISTS abneon_captured_at timestamptz,
         ADD COLUMN IF NOT EXISTS level_source text NOT NULL DEFAULT 'stealth_legacy',
         ADD COLUMN IF NOT EXISTS legacy_breakout_level double precision,
         ADD COLUMN IF NOT EXISTS experiment_version text
          ,ADD COLUMN IF NOT EXISTS armed_after_4h_at timestamptz
    `);
    // Existing continuation rows are retained for audit/retry lifecycle, but
    // their cursor must be explicit before the scanner can evaluate them.
    await tx.execute(drizzleSql`
      UPDATE stealth_breakout_armed_setups
         SET armed_after_4h_at = COALESCE(armed_after_4h_at, armed_after_1h_at)
       WHERE armed_after_4h_at IS NULL
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS stealth_continuation_shelf_events (
        id bigserial PRIMARY KEY,
        event_key text NOT NULL UNIQUE,
        arm_id integer NOT NULL REFERENCES stealth_breakout_armed_setups(id),
        symbol text NOT NULL,
        event_type text NOT NULL,
        event_at timestamptz NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS stealth_breakout_decision_metrics (
        id bigserial PRIMARY KEY,
        event_key text NOT NULL UNIQUE,
        arm_id integer NOT NULL,
        symbol text NOT NULL,
        level_source text NOT NULL,
        trigger_candle_at timestamptz,
        observed_at timestamptz NOT NULL DEFAULT now(),
        outcome text NOT NULL,
        metrics jsonb NOT NULL
      )
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS stealth_breakout_decision_metrics_symbol_idx
        ON stealth_breakout_decision_metrics (symbol, observed_at)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS stealth_continuation_shelf_events_arm_idx
        ON stealth_continuation_shelf_events (arm_id, event_at)
    `);
    await tx.execute(drizzleSql`
      UPDATE stealth_breakout_armed_setups
      SET
        status = 'invalidated',
        terminal_reason = 'legacy_pre_fresh_ceiling_rules',
        decision_at = now(),
        decision_json = COALESCE(decision_json, '{}'::jsonb) ||
          jsonb_build_object(
            'status', 'invalidated',
            'reason', 'legacy_pre_fresh_ceiling_rules',
            'evaluatedAt', (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
            'frozenLevel', breakout_level,
            'breakoutSource', breakout_source
          ),
        updated_at = now()
      WHERE status IN ('armed', 'qualified')
        AND decision_json IS NULL
    `);
    await tx.execute(drizzleSql`
      UPDATE stealth_breakout_armed_setups
      SET
        status = 'invalidated',
        terminal_reason = 'fire_claim_expired_before_persist',
        decision_at = now(),
        decision_json = COALESCE(decision_json, '{}'::jsonb) ||
          jsonb_build_object(
            'status', 'invalidated',
            'reason', 'fire_claim_expired_before_persist',
            'evaluatedAt', (EXTRACT(EPOCH FROM now()) * 1000)::bigint
          ),
        updated_at = now()
      WHERE status = 'firing'
        AND (fire_claimed_at IS NULL OR fire_claimed_at < now() - interval '10 minutes')
    `);
    // 4H Range detection was removed (owner, 2026-10-10): close leftover arms.
    await tx.execute(drizzleSql`
      UPDATE stealth_breakout_armed_setups
      SET
        status = 'invalidated',
        terminal_reason = 'auto_range_4h_removed',
        decision_at = now(),
        decision_json = COALESCE(decision_json, '{}'::jsonb) ||
          jsonb_build_object(
            'status', 'invalidated',
            'reason', 'auto_range_4h_removed',
            'evaluatedAt', (EXTRACT(EPOCH FROM now()) * 1000)::bigint
          ),
        updated_at = now()
      WHERE level_source = 'auto_range_4h'
        AND status IN ('armed', 'qualified')
    `);
    await tx.execute(drizzleSql`
      DROP INDEX IF EXISTS stealth_breakout_one_active_arm_idx
    `);
    await tx.execute(drizzleSql`
      DROP INDEX IF EXISTS stealth_breakout_one_active_arm_per_method_idx
    `);
    // The venue discriminator is a plain column (kept in sync from
    // decision_json by a trigger) so the unique index is a simple column index
    // that schema diff tooling can serialize.
    await tx.execute(drizzleSql`
      ALTER TABLE stealth_breakout_armed_setups
        ADD COLUMN IF NOT EXISTS arm_venue text NOT NULL DEFAULT 'default'
    `);
    await tx.execute(drizzleSql`
      CREATE OR REPLACE FUNCTION stealth_breakout_armed_set_arm_venue()
      RETURNS trigger AS $fn$
      BEGIN
        NEW.arm_venue := CASE
          WHEN NEW.level_source = 'auto_range_4h'
            THEN COALESCE(NEW.decision_json #>> '{autoRangeIdentity,venue}', 'bingx')
          WHEN NEW.level_source = 'auto_range_1h'
            AND NEW.decision_json ->> 'armSlot' = 'secondary'
            THEN 'secondary'
          ELSE 'default'
        END;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql
    `);
    await tx.execute(drizzleSql`
      DROP TRIGGER IF EXISTS stealth_breakout_armed_arm_venue_trg
        ON stealth_breakout_armed_setups
    `);
    await tx.execute(drizzleSql`
      CREATE TRIGGER stealth_breakout_armed_arm_venue_trg
        BEFORE INSERT OR UPDATE OF decision_json, level_source
        ON stealth_breakout_armed_setups
        FOR EACH ROW EXECUTE FUNCTION stealth_breakout_armed_set_arm_venue()
    `);
    await tx.execute(drizzleSql`
      UPDATE stealth_breakout_armed_setups
      SET arm_venue = CASE
        WHEN level_source = 'auto_range_4h'
          THEN COALESCE(decision_json #>> '{autoRangeIdentity,venue}', 'bingx')
        WHEN level_source = 'auto_range_1h'
          AND decision_json ->> 'armSlot' = 'secondary'
          THEN 'secondary'
        ELSE 'default'
      END
      WHERE arm_venue IS DISTINCT FROM CASE
        WHEN level_source = 'auto_range_4h'
          THEN COALESCE(decision_json #>> '{autoRangeIdentity,venue}', 'bingx')
        WHEN level_source = 'auto_range_1h'
          AND decision_json ->> 'armSlot' = 'secondary'
          THEN 'secondary'
        ELSE 'default'
      END
    `);
    await tx.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS stealth_breakout_one_active_arm_per_method_idx
        ON stealth_breakout_armed_setups (symbol, level_source, arm_venue)
        WHERE status = 'armed'
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS stealth_breakout_armed_status_expiry_idx
        ON stealth_breakout_armed_setups (status, expires_at)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS stealth_breakout_armed_fired_signal_idx
        ON stealth_breakout_armed_setups (fired_signal_id)
        WHERE fired_signal_id IS NOT NULL
    `);
  });
}

async function ensureTrackedStatusSchema(): Promise<void> {
  await db.execute(
    drizzleSql`ALTER TYPE tracked_status ADD VALUE IF NOT EXISTS 'reclassified'`,
  );
  await db.execute(
    drizzleSql`ALTER TYPE tracked_status ADD VALUE IF NOT EXISTS 'expired' AFTER 'breakeven'`,
  );
  // ACCUMULATION and RE-ENTRY are Telegram accompaniment events, not position
  // states. Keep legacy enum values in PostgreSQL for migration compatibility,
  // but normalize every historical row before runtime queries begin.
  await db.execute(drizzleSql`
    UPDATE tracked_signals
       SET status = 'active',
           updated_at = NOW()
     WHERE status::text IN ('accumulation', 're_entry')
  `);
  await db.execute(drizzleSql`
    UPDATE signal_trajectory_log
       SET status = 'active'
     WHERE status IN ('accumulation', 're_entry')
  `);
  // The 4-day timeout branch was historically the only writer of breakeven.
  // Preserve the recorded exit/PnL while separating lifetime expiry from a
  // genuine neutral close in every downstream report and dashboard.
  await db.execute(drizzleSql`
    UPDATE tracked_signals
       SET status = 'expired',
           updated_at = NOW()
     WHERE status = 'breakeven'
  `);
  await db.execute(drizzleSql`
    UPDATE signal_trajectory_log
       SET status = 'expired'
     WHERE interval_label = 'close'
       AND status = 'breakeven'
  `);
}

/**
 * Bullish Accumulation is decommissioned. Existing open positions from that
 * pattern are administrative reclassifications, not trade cancellations:
 * changing them directly keeps outcome/statistics and all delivery ledgers
 * untouched. The advisory lock makes concurrent production workers harmless,
 * while the open-status predicate makes subsequent starts no-ops.
 */
async function reclassifyOpenBullishAccumulationPositions(): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('bullish_accumulation_open_position_reclassification'))`,
    );
    const result = await tx.execute(drizzleSql`
      UPDATE tracked_signals
         SET status = 'reclassified',
             cancel_reason = 'pattern_removed',
             exit_price = NULL,
             pnl_percent = NULL,
             closed_at = NULL,
             trailing_stop_level = NULL,
             last_smart_cancel_check_at = NULL,
             updated_at = NOW()
       WHERE sentiment_key = 'bullish_accumulation'
         AND status IN ('active', 'in_run')
    `);
    const count = Number((result as any).rowCount ?? 0);
    logger.info(
      { count },
      "Bullish Accumulation open positions reclassified at startup",
    );
    return count;
  });
}

/**
 * ONDO and APT were fired before the tightened Impulse Buy entry gates were
 * published. The owner explicitly chose to remove these still-open positions
 * from tracking without manufacturing a cancellation or trading outcome.
 *
 * Exact tracker ids and symbols fence this one-time production correction.
 * The live-gate predicate and open-status predicate make it both auditable and
 * idempotent.
 */
async function reclassifyOpenImpulseBuyPositionsExcludedByCurrentGates(): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('impulse_buy_open_gate_reclassification_20260911'))`,
    );
    const result = await tx.execute(drizzleSql`
      UPDATE tracked_signals
         SET status = 'reclassified',
             cancel_reason = 'entry_gate_reclassified',
             exit_price = NULL,
             pnl_percent = NULL,
             closed_at = NULL,
             trailing_stop_level = NULL,
             last_smart_cancel_check_at = NULL,
             updated_at = NOW()
       WHERE (id, symbol) IN ((1598, 'ONDO-USDT'), (1600, 'APT-USDT'))
         AND sentiment_key = 'impulse_buy'
         AND status IN ('active', 'in_run')
         AND (entry_spot_vol_mult > 2 OR entry_oi_4h > 20)
    `);
    const count = Number((result as any).rowCount ?? 0);
    logger.info(
      { count },
      "Pre-gate Impulse Buy open positions reclassified at startup",
    );
    return count;
  });
}

/**
 * CHZ, MINA, and PHA were fired before PLM gained its calibrated p3h <= 5%
 * live gate. The owner approved removing only these still-open pre-gate
 * positions from tracking without manufacturing a cancellation or outcome.
 *
 * Exact tracker/signal identities, immutable p3h, pattern, and open status make
 * the production correction auditable, idempotent, and safe across workers.
 */
async function reclassifyOpenPlmPositionsExcludedByP3hGate(): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('plm_open_p3h_gate_reclassification_20260913'))`,
    );
    const result = await tx.execute(drizzleSql`
      UPDATE tracked_signals
         SET status = 'reclassified',
             cancel_reason = 'entry_gate_reclassified',
             exit_price = NULL,
             pnl_percent = NULL,
             closed_at = NULL,
             trailing_stop_level = NULL,
             last_smart_cancel_check_at = NULL,
             updated_at = NOW()
       WHERE (id, symbol, signal_id) IN (
         (1623, 'CHZ-USDT', 5662),
         (1628, 'MINA-USDT', 5688),
         (1635, 'PHA-USDT', 5724)
       )
         AND sentiment_key = 'price_led_momentum'
         AND status IN ('active', 'in_run')
         AND entry_price_3h > 5
    `);
    const count = Number((result as any).rowCount ?? 0);
    logger.info(
      { count },
      "Pre-gate PLM open positions reclassified at startup",
    );
    return count;
  });
}

async function reclassifyInvalidOpenNeonSupportPosition(): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('neon_support_zec_reclassification_20260913'))`,
    );
    const result = await tx.execute(drizzleSql`
      UPDATE tracked_signals
         SET status = 'reclassified',
             cancel_reason = 'invalid_support_level_reclassified',
             exit_price = NULL,
             pnl_percent = NULL,
             closed_at = NULL,
             trailing_stop_level = NULL,
             last_smart_cancel_check_at = NULL,
             updated_at = NOW()
       WHERE id = 1639
         AND symbol = 'ZEC-USDT'
         AND sentiment_key = 'neon_support_bounce'
         AND status IN ('active', 'in_run')
    `);
    const count = Number((result as any).rowCount ?? 0);
    logger.info(
      { count },
      "Invalid Neon Support ZEC position reclassified at startup",
    );
    return count;
  });
}

async function reclassifyInvalidOpenStealthBreakoutPositions(): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('stealth_false_breakout_reclassification_20260913'))`,
    );
    const result = await tx.execute(drizzleSql`
      UPDATE tracked_signals
         SET status = 'reclassified',
             cancel_reason = 'false_breakout_reclassified',
             exit_price = NULL,
             pnl_percent = NULL,
             closed_at = NULL,
             trailing_stop_level = NULL,
             last_smart_cancel_check_at = NULL,
             updated_at = NOW()
       WHERE (id, symbol) IN (
         (1626, 'KAT-USDT'),
         (1633, 'PENDLE-USDT'),
         (1638, 'ALICE-USDT')
       )
         AND sentiment_key = 'stealth_breakout'
         AND status IN ('active', 'in_run')
    `);
    const count = Number((result as any).rowCount ?? 0);
    logger.info(
      { count },
      "Invalid Stealth Breakout positions reclassified at startup",
    );
    return count;
  });
}

/**
 * Move only production-reviewed false crosses back to neutral observation.
 * Exact tracker, signal, arm, and symbol identity prevents a later event for
 * the same ticker from being touched on a subsequent restart.
 */
async function reclassifyReviewedOpenStealthBreakouts(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;

  return db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('stealth_reviewed_inner_shelf_reclassification_20260914'))`,
    );
    const tracked = await tx.execute(drizzleSql`
      WITH targets(tracked_id, signal_id, arm_id, symbol) AS (
        VALUES
          (1660, 5870, 2157, 'CHR-USDT'),
          (1644, 5772, 2102, 'TAIKO-USDT'),
          (1910, 10452, 3662, 'APEX-USDT'),
          (1909, 10363, 3628, 'MEW-USDT')
      )
      UPDATE tracked_signals AS t
         SET status = 'reclassified',
             cancel_reason = 'false_breakout_reclassified',
             exit_price = NULL,
             pnl_percent = NULL,
             closed_at = NULL,
             trailing_stop_level = NULL,
             last_smart_cancel_check_at = NULL,
             updated_at = NOW()
        FROM targets AS x
       WHERE t.id = x.tracked_id
         AND t.signal_id = x.signal_id
         AND t.symbol = x.symbol
         AND t.sentiment_key = 'stealth_breakout'
         AND t.status IN ('active', 'in_run')
         AND NOT (
           t.runner_state = 'open'
           AND t.core_closed_at IS NOT NULL
         )
      RETURNING t.id, t.symbol
    `);

    await tx.execute(drizzleSql`
      WITH targets(tracked_id, signal_id, arm_id, symbol) AS (
        VALUES
          (1660, 5870, 2157, 'CHR-USDT'),
          (1644, 5772, 2102, 'TAIKO-USDT'),
          (1910, 10452, 3662, 'APEX-USDT'),
          (1909, 10363, 3628, 'MEW-USDT')
      )
      UPDATE stealth_breakout_armed_setups AS a
         SET status = 'reclassified',
             terminal_reason = 'false_breakout_reclassified',
             updated_at = NOW()
        FROM targets AS x
       WHERE a.id = x.arm_id
         AND a.fired_signal_id = x.signal_id
         AND a.symbol = x.symbol
         AND a.status = 'fired'
         AND EXISTS (
           SELECT 1
             FROM tracked_signals AS t
            WHERE t.id = x.tracked_id
              AND t.signal_id = x.signal_id
              AND t.symbol = x.symbol
              AND t.sentiment_key = 'stealth_breakout'
              AND t.status = 'reclassified'
              AND t.cancel_reason = 'false_breakout_reclassified'
         )
    `);

    // The original photos remain audit history, but unsent follow-up alerts
    // must not announce a neutral observation as an active trade.
    await tx.execute(drizzleSql`
      UPDATE milestone_notification_deliveries
         SET status = 'abandoned',
             lease_until = NULL,
             claim_token = NULL,
             last_error = 'false_breakout_reclassified'
       WHERE tracked_signal_id IN (1909, 1910)
         AND status IN ('ready', 'failed')
         AND EXISTS (
           SELECT 1 FROM tracked_signals t
            WHERE t.id = milestone_notification_deliveries.tracked_signal_id
              AND t.status = 'reclassified'
              AND t.cancel_reason = 'false_breakout_reclassified'
         )
    `);
    await tx.execute(drizzleSql`
      UPDATE telegram_photo_deliveries p
         SET status = 'abandoned',
             lease_until = NULL,
             claim_token = NULL,
             last_error = 'false_breakout_reclassified',
             updated_at = NOW()
       WHERE p.status IN ('ready', 'failed')
         AND EXISTS (
           SELECT 1 FROM tracked_signals t
            WHERE t.id IN (1909, 1910)
              AND t.status = 'reclassified'
              AND t.cancel_reason = 'false_breakout_reclassified'
              AND (
                p.dedup_key = 'signal:' || t.signal_id::text
                OR p.dedup_key LIKE 'position:' || t.id::text || ':%'
                OR p.dedup_key LIKE 'milestone:v3:' || t.id::text || ':%'
              )
         )
    `);

    const count = Number((tracked as any).rowCount ?? 0);
    logger.info(
      {
        count,
        symbols: (tracked.rows as Array<{ symbol: string }>).map(
          (row) => row.symbol,
        ),
      },
      "Reviewed Stealth inner-shelf crosses moved to neutral observation",
    );
    return count;
  });
}

/**
 * Permanently remove the exact set of invalid cancelled Impulse Buy trades
 * identified by the owner. This is deliberately a production-only, identity
 * fenced correction: no symbol/time/status-only predicate may broaden it.
 */
async function deleteInvalidCancelledImpulseBuyTrades(): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;

  const targets = [
    [1587, "XAN-USDT", 5486],
    [1590, "UAI-USDT", 5512],
    [1594, "THETA-USDT", 5524],
    [1599, "PUMP-USDT", 5534],
    [1604, "ARB-USDT", 5552],
    [1605, "ENA-USDT", 5558],
    [1606, "1000BONK-USDT", 5562],
    [1607, "SEI-USDT", 5564],
    [1608, "DYM-USDT", 5566],
    [1609, "MINA-USDT", 5570],
    [1618, "BLUR-USDT", 5620],
  ] as const;

  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('invalid_cancelled_impulse_buy_trades_delete_202610'))`,
    );
    await tx.execute(drizzleSql`
      CREATE TEMP TABLE startup_invalid_cancelled_impulse_buy_targets (
        tracker_id integer PRIMARY KEY,
        symbol text NOT NULL,
        signal_id integer NOT NULL
      ) ON COMMIT DROP
    `);
    for (const [trackerId, symbol, signalId] of targets) {
      await tx.execute(drizzleSql`
        INSERT INTO startup_invalid_cancelled_impulse_buy_targets
          (tracker_id, symbol, signal_id)
        VALUES (${trackerId}, ${symbol}, ${signalId})
      `);
    }

    // Lock both ledgers before validating them. A rerun is safe only when all
    // 11 pairs are absent; a mixed/partial state is an operator error.
    const lockedTrackers = await tx.execute(drizzleSql`
      SELECT t.id
        FROM tracked_signals t
        JOIN startup_invalid_cancelled_impulse_buy_targets x
          ON x.tracker_id = t.id
       FOR UPDATE
    `);
    const lockedSignals = await tx.execute(drizzleSql`
      SELECT s.id
        FROM signals s
        JOIN startup_invalid_cancelled_impulse_buy_targets x
          ON x.signal_id = s.id
       FOR UPDATE
    `);
    const identityRows = await tx.execute(drizzleSql`
      SELECT
        x.tracker_id,
        x.symbol AS expected_symbol,
        x.signal_id,
        t.id AS actual_tracker_id,
        t.signal_id AS actual_tracker_signal_id,
        t.symbol AS actual_tracker_symbol,
        t.sentiment_key AS actual_tracker_sentiment_key,
        t.status AS actual_tracker_status,
        s.id AS actual_signal_id,
        s.symbol AS actual_signal_symbol,
        s.sentiment_key AS actual_signal_sentiment_key
      FROM startup_invalid_cancelled_impulse_buy_targets x
      LEFT JOIN tracked_signals t ON t.id = x.tracker_id
      LEFT JOIN signals s ON s.id = x.signal_id
      ORDER BY x.tracker_id
    `);
    const rows = identityRows.rows as Array<Record<string, unknown>>;
    const presentCount = rows.filter(
      (row) => row.actual_tracker_id !== null || row.actual_signal_id !== null,
    ).length;
    if (presentCount !== 0 && presentCount !== targets.length) {
      throw new Error(
        `Impulse Buy deletion correction found partial target state (${presentCount}/${targets.length})`,
      );
    }
    for (const row of rows) {
      if (row.actual_tracker_id === null && row.actual_signal_id === null)
        continue;
      const exact =
        Number(row.actual_tracker_id) === Number(row.tracker_id) &&
        Number(row.actual_tracker_signal_id) === Number(row.signal_id) &&
        String(row.actual_tracker_symbol) === String(row.expected_symbol) &&
        String(row.actual_tracker_sentiment_key) === "impulse_buy" &&
        String(row.actual_tracker_status) === "cancelled" &&
        Number(row.actual_signal_id) === Number(row.signal_id) &&
        String(row.actual_signal_symbol) === String(row.expected_symbol) &&
        String(row.actual_signal_sentiment_key) === "impulse_buy";
      if (!exact) {
        throw new Error(
          `Impulse Buy deletion correction identity mismatch for tracker ${String(row.tracker_id)}`,
        );
      }
    }
    if (presentCount === 0) {
      logger.info(
        { targets: targets.length, trackers: 0, signals: 0 },
        "Invalid cancelled Impulse Buy correction already complete",
      );
      return;
    }
    if (
      lockedTrackers.rows.length !== targets.length ||
      lockedSignals.rows.length !== targets.length
    ) {
      throw new Error("Impulse Buy deletion correction lock coverage mismatch");
    }

    const counts: Record<string, number> = {};
    const countRows = (result: { rows: unknown[]; rowCount?: number | null }) =>
      Number(result.rowCount ?? result.rows.length);
    const relationExists = async (tableName: string): Promise<boolean> => {
      const result = await tx.execute(
        drizzleSql`SELECT to_regclass(${`public.${tableName}`}) IS NOT NULL AS present`,
      );
      return Boolean(
        (result.rows[0] as { present?: boolean } | undefined)?.present,
      );
    };
    const columnExists = async (
      tableName: string,
      columnName: string,
    ): Promise<boolean> => {
      const result = await tx.execute(drizzleSql`
        SELECT EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = ${tableName}
             AND column_name = ${columnName}
        ) AS present
      `);
      return Boolean(
        (result.rows[0] as { present?: boolean } | undefined)?.present,
      );
    };

    // A source signal must have exactly its specified tracker and no other
    // tracker reference. Lock every reference before this preflight so an
    // unexpected duplicate cannot appear between validation and deletion.
    await tx.execute(drizzleSql`
      SELECT t.id
        FROM tracked_signals t
        JOIN startup_invalid_cancelled_impulse_buy_targets x
          ON x.signal_id = t.signal_id
       FOR UPDATE
    `);
    const sourceTrackerRefs = await tx.execute(drizzleSql`
      SELECT
        x.tracker_id,
        x.signal_id,
        COUNT(t.id)::integer AS tracker_ref_count,
        COALESCE(
          ARRAY_AGG(t.id ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL),
          ARRAY[]::integer[]
        ) AS tracker_ids
      FROM startup_invalid_cancelled_impulse_buy_targets x
      LEFT JOIN tracked_signals t ON t.signal_id = x.signal_id
      GROUP BY x.tracker_id, x.signal_id
      ORDER BY x.tracker_id
    `);
    for (const row of sourceTrackerRefs.rows as Array<
      Record<string, unknown>
    >) {
      const trackerIds = Array.isArray(row.tracker_ids)
        ? row.tracker_ids.map(Number)
        : [];
      if (
        Number(row.tracker_ref_count) !== 1 ||
        trackerIds[0] !== Number(row.tracker_id)
      ) {
        throw new Error(
          `Impulse Buy deletion correction preflight failed for source ${String(row.signal_id)}: expected exactly tracker ${String(row.tracker_id)}, found [${trackerIds.join(", ")}]`,
        );
      }
    }

    const trackerDeletes = {
      milestone_notification_deliveries: async () =>
        tx.execute(drizzleSql`
          DELETE FROM milestone_notification_deliveries d
           USING startup_invalid_cancelled_impulse_buy_targets x
           WHERE d.tracked_signal_id = x.tracker_id
           RETURNING d.id
        `),
      bu_stop_followup_snapshots: async () =>
        tx.execute(drizzleSql`
          DELETE FROM bu_stop_followup_snapshots d
           USING startup_invalid_cancelled_impulse_buy_targets x
           WHERE d.tracked_signal_id = x.tracker_id
           RETURNING d.id
        `),
    };
    for (const [tableName, deleteRows] of Object.entries(trackerDeletes)) {
      counts[tableName] = countRows(await deleteRows());
    }

    counts.altbullet_take_profit_shadow = countRows(
      await tx.execute(drizzleSql`
        DELETE FROM altbullet_take_profit_shadow d
         USING startup_invalid_cancelled_impulse_buy_targets x
         WHERE d.tracked_signal_id = x.tracker_id
            OR d.signal_id = x.signal_id
         RETURNING d.id
      `),
    );
    if (await relationExists("pattern_backfill_candles")) {
      counts.pattern_backfill_candles = countRows(
        await tx.execute(drizzleSql`
          DELETE FROM pattern_backfill_candles c
           USING pattern_decision_snapshots d,
                 startup_invalid_cancelled_impulse_buy_targets x
           WHERE c.decision_snapshot_id = d.id
             AND (d.tracked_signal_id = x.tracker_id OR d.signal_id = x.signal_id)
           RETURNING c.id
        `),
      );
    } else {
      counts.pattern_backfill_candles = 0;
    }
    counts.pattern_decision_snapshots = countRows(
      await tx.execute(drizzleSql`
        DELETE FROM pattern_decision_snapshots d
         USING startup_invalid_cancelled_impulse_buy_targets x
         WHERE d.tracked_signal_id = x.tracker_id
            OR d.signal_id = x.signal_id
         RETURNING d.id
      `),
    );

    for (const tableName of [
      "signal_trajectory_log",
      "signal_drawdown_extrema",
      "signal_trailing_events",
      "signal_trailing_shadow_events",
      "signal_profit_lock_shadow_events",
      "signal_health_events",
      "signal_cancel_outcomes",
    ]) {
      if (!(await relationExists(tableName))) {
        counts[tableName] = 0;
        continue;
      }
      const result = await tx.execute(
        drizzleSql.raw(`
          DELETE FROM ${tableName} d
           USING startup_invalid_cancelled_impulse_buy_targets x
           WHERE d.signal_id = x.tracker_id
           RETURNING d.id
        `),
      );
      counts[tableName] = countRows(result);
    }

    counts.altbullet_indicator_snapshots = countRows(
      await tx.execute(drizzleSql`
        DELETE FROM altbullet_indicator_snapshots d
         USING startup_invalid_cancelled_impulse_buy_targets x
         WHERE d.signal_id = x.signal_id
         RETURNING d.id
      `),
    );
    counts.liq_cascade_candidate_observations = countRows(
      await tx.execute(drizzleSql`
        DELETE FROM liq_cascade_candidate_observations d
         USING startup_invalid_cancelled_impulse_buy_targets x
         WHERE d.signal_id = x.signal_id
         RETURNING d.id
      `),
    );
    counts.stealth_breakout_armed_setups = countRows(
      await tx.execute(drizzleSql`
        UPDATE stealth_breakout_armed_setups d
           SET fired_signal_id = NULL
         FROM startup_invalid_cancelled_impulse_buy_targets x
         WHERE d.fired_signal_id = x.signal_id
         RETURNING d.id
      `),
    );
    counts.stealth_breakout_observations = countRows(
      await tx.execute(drizzleSql`
        UPDATE stealth_breakout_observations d
           SET confirmation_signal_id = NULL
         FROM startup_invalid_cancelled_impulse_buy_targets x
         WHERE d.confirmation_signal_id = x.signal_id
         RETURNING d.id
      `),
    );
    if (await relationExists("signal_whale_seeds")) {
      counts.signal_whale_seeds = countRows(
        await tx.execute(drizzleSql`
          DELETE FROM signal_whale_seeds d
           USING startup_invalid_cancelled_impulse_buy_targets x
           WHERE d.signal_id = x.signal_id
           RETURNING 1
        `),
      );
      if (await columnExists("signal_whale_seeds", "tracked_signal_id")) {
        counts.signal_whale_seeds_tracked = countRows(
          await tx.execute(drizzleSql`
            DELETE FROM signal_whale_seeds d
             USING startup_invalid_cancelled_impulse_buy_targets x
             WHERE d.tracked_signal_id = x.tracker_id
             RETURNING 1
          `),
        );
      } else {
        counts.signal_whale_seeds_tracked = 0;
      }
    } else {
      counts.signal_whale_seeds = 0;
      counts.signal_whale_seeds_tracked = 0;
    }

    await tx.execute(drizzleSql`
      CREATE TEMP TABLE startup_invalid_cancelled_impulse_buy_photo_ids (
        id integer PRIMARY KEY
      ) ON COMMIT DROP
    `);
    await tx.execute(drizzleSql`
      INSERT INTO startup_invalid_cancelled_impulse_buy_photo_ids (id)
      SELECT p.id
        FROM telegram_photo_deliveries p
       WHERE p.dedup_key IN (
         SELECT 'signal:' || x.signal_id::text
           FROM startup_invalid_cancelled_impulse_buy_targets x
       )
          OR EXISTS (
            SELECT 1
              FROM startup_invalid_cancelled_impulse_buy_targets x
             WHERE p.dedup_key LIKE 'cancel:' || x.tracker_id::text || ':%'
                OR p.dedup_key LIKE 'position:' || x.tracker_id::text || ':%'
                OR p.dedup_key LIKE 'milestone:v3:' || x.tracker_id::text || ':%'
          )
    `);
    counts.telegram_delivery_attempt_audit = countRows(
      await tx.execute(drizzleSql`
        DELETE FROM telegram_delivery_attempt_audit a
         WHERE a.delivery_id IN (
           SELECT p.id
             FROM startup_invalid_cancelled_impulse_buy_photo_ids p
         )
            OR a.dedup_key IN (
              SELECT 'signal:' || x.signal_id::text
                FROM startup_invalid_cancelled_impulse_buy_targets x
            )
            OR EXISTS (
              SELECT 1
                FROM startup_invalid_cancelled_impulse_buy_targets x
               WHERE a.dedup_key LIKE 'cancel:' || x.tracker_id::text || ':%'
                  OR a.dedup_key LIKE 'position:' || x.tracker_id::text || ':%'
                  OR a.dedup_key LIKE 'milestone:v3:' || x.tracker_id::text || ':%'
            )
         RETURNING a.id
      `),
    );
    counts.telegram_photo_deliveries = countRows(
      await tx.execute(drizzleSql`
        DELETE FROM telegram_photo_deliveries d
         USING startup_invalid_cancelled_impulse_buy_photo_ids p
         WHERE d.id = p.id
         RETURNING d.id
      `),
    );
    counts.telegram_delivery_events = countRows(
      await tx.execute(drizzleSql`
        DELETE FROM telegram_delivery_events d
         WHERE d.event_key IN (
           SELECT 'signal:' || x.signal_id::text
             FROM startup_invalid_cancelled_impulse_buy_targets x
         )
            OR EXISTS (
              SELECT 1
                FROM startup_invalid_cancelled_impulse_buy_targets x
               WHERE d.event_key LIKE 'cancel:' || x.tracker_id::text || ':%'
                  OR d.event_key LIKE 'position:' || x.tracker_id::text || ':%'
                  OR d.event_key LIKE 'milestone:v3:' || x.tracker_id::text || ':%'
            )
         RETURNING d.id
      `),
    );

    if (await relationExists("prescan_telemetry_outbox")) {
      counts.prescan_telemetry_outbox = countRows(
        await tx.execute(drizzleSql`
          DELETE FROM prescan_telemetry_outbox d
           USING startup_invalid_cancelled_impulse_buy_targets x
           WHERE (
             (d.payload ? 'signalId'
               AND d.payload->>'signalId' ~ '^[0-9]+$'
               AND (d.payload->>'signalId')::bigint = x.signal_id)
             OR
             (d.payload ? 'trackedSignalId'
               AND d.payload->>'trackedSignalId' ~ '^[0-9]+$'
               AND (d.payload->>'trackedSignalId')::bigint = x.tracker_id)
             OR
             (d.payload ? 'signal_id'
               AND d.payload->>'signal_id' ~ '^[0-9]+$'
               AND (d.payload->>'signal_id')::bigint = x.signal_id)
             OR
             (d.payload ? 'tracked_signal_id'
               AND d.payload->>'tracked_signal_id' ~ '^[0-9]+$'
               AND (d.payload->>'tracked_signal_id')::bigint = x.tracker_id)
           )
           RETURNING d.id
        `),
      );
    } else {
      counts.prescan_telemetry_outbox = 0;
    }

    counts.tracked_signals = countRows(
      await tx.execute(drizzleSql`
        DELETE FROM tracked_signals d
         USING startup_invalid_cancelled_impulse_buy_targets x
         WHERE d.id = x.tracker_id
           AND d.signal_id = x.signal_id
           AND d.symbol = x.symbol
           AND d.sentiment_key = 'impulse_buy'
           AND d.status = 'cancelled'
         RETURNING d.id
      `),
    );
    counts.signals = countRows(
      await tx.execute(drizzleSql`
        DELETE FROM signals d
         USING startup_invalid_cancelled_impulse_buy_targets x
         WHERE d.id = x.signal_id
           AND d.symbol = x.symbol
           AND d.sentiment_key = 'impulse_buy'
         RETURNING d.id
      `),
    );
    if (
      counts.tracked_signals !== targets.length ||
      counts.signals !== targets.length
    ) {
      throw new Error(
        `Impulse Buy deletion correction delete count mismatch (${counts.tracked_signals}/${targets.length} trackers, ${counts.signals}/${targets.length} signals)`,
      );
    }
    logger.info(
      { targets: targets.length, ...counts },
      "Invalid cancelled Impulse Buy trades permanently deleted",
    );
  });
}

/**
 * Remove the two Stealth rows that were admitted under the old 1H live
 * contract.  This is intentionally a separate, production-only correction:
 * exact (tracker, symbol, source, arm) identity is preflighted under one
 * transaction lock and every mismatch/partial state aborts before mutation.
 */
async function deleteInvalidStealthQuietZoneTrades(): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;
  const targets = [
    [1615, "ZORA-USDT", 5602, 1964],
    [1619, "INX-USDT", 5624, 1966],
  ] as const;
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('stealth_quiet_zone_invalid_trades_delete_20260912'))`,
    );
    await tx.execute(drizzleSql`
      CREATE TEMP TABLE startup_invalid_stealth_targets (
        tracker_id integer PRIMARY KEY,
        symbol text NOT NULL,
        source_id integer NOT NULL,
        arm_id integer NOT NULL
      ) ON COMMIT DROP
    `);
    for (const [trackerId, symbol, sourceId, armId] of targets) {
      await tx.execute(drizzleSql`
        INSERT INTO startup_invalid_stealth_targets
          (tracker_id, symbol, source_id, arm_id)
        VALUES (${trackerId}, ${symbol}, ${sourceId}, ${armId})
      `);
    }

    await tx.execute(drizzleSql`
      SELECT t.id FROM tracked_signals t
       JOIN startup_invalid_stealth_targets x ON x.tracker_id = t.id
      FOR UPDATE
    `);
    await tx.execute(drizzleSql`
      SELECT s.id FROM signals s
       JOIN startup_invalid_stealth_targets x ON x.source_id = s.id
      FOR UPDATE
    `);
    await tx.execute(drizzleSql`
      SELECT a.id FROM stealth_breakout_armed_setups a
       JOIN startup_invalid_stealth_targets x ON x.arm_id = a.id
      FOR UPDATE
    `);
    const identity = await tx.execute(drizzleSql`
      SELECT
        x.tracker_id, x.symbol, x.source_id, x.arm_id,
        t.id AS actual_tracker_id, t.signal_id AS tracker_source_id,
        t.symbol AS tracker_symbol, t.sentiment_key AS tracker_pattern,
        t.stealth_detection_method AS tracker_method, t.status AS tracker_status,
        s.id AS actual_source_id, s.symbol AS source_symbol,
        s.sentiment_key AS source_pattern,
        s.stealth_detection_method AS source_method,
        a.id AS actual_arm_id, a.symbol AS arm_symbol,
        a.fired_signal_id AS arm_source_id,
        a.level_source AS arm_level_source
      FROM startup_invalid_stealth_targets x
      LEFT JOIN tracked_signals t ON t.id = x.tracker_id
      LEFT JOIN signals s ON s.id = x.source_id
      LEFT JOIN stealth_breakout_armed_setups a ON a.id = x.arm_id
      ORDER BY x.tracker_id
    `);
    const rows = identity.rows as Array<Record<string, unknown>>;
    const presence = rows.map(
      (row) =>
        row.actual_tracker_id !== null ||
        row.actual_source_id !== null ||
        row.actual_arm_id !== null,
    );
    const presentCount = presence.filter(Boolean).length;
    if (presentCount !== 0 && presentCount !== targets.length) {
      throw new Error(
        `Stealth deletion correction found partial target state (${presentCount}/${targets.length})`,
      );
    }
    for (const row of rows) {
      if (
        row.actual_tracker_id === null &&
        row.actual_source_id === null &&
        row.actual_arm_id === null
      )
        continue;
      const exact =
        Number(row.actual_tracker_id) === Number(row.tracker_id) &&
        Number(row.tracker_source_id) === Number(row.source_id) &&
        String(row.tracker_symbol) === String(row.symbol) &&
        ["active", "in_run"].includes(String(row.tracker_status)) &&
        String(row.tracker_pattern) === "stealth_breakout" &&
        String(row.tracker_method) === "quiet_zone_breakout" &&
        Number(row.actual_source_id) === Number(row.source_id) &&
        String(row.source_symbol) === String(row.symbol) &&
        String(row.source_pattern) === "stealth_breakout" &&
        String(row.source_method) === "quiet_zone_breakout" &&
        Number(row.actual_arm_id) === Number(row.arm_id) &&
        String(row.arm_symbol) === String(row.symbol) &&
        Number(row.arm_source_id) === Number(row.source_id) &&
        String(row.arm_level_source) === "stealth_legacy";
      if (!exact) {
        throw new Error(
          `Stealth deletion correction identity mismatch for tracker ${String(row.tracker_id)}`,
        );
      }
    }
    if (presentCount === 0) {
      logger.info(
        { targets: targets.length, deleted: 0 },
        "Invalid Stealth quiet-zone correction already complete",
      );
      return;
    }
    // Lock and validate every source reference before touching any dependent.
    // A source with an additional tracker is an identity mismatch, not a
    // reason to broaden this correction.
    await tx.execute(drizzleSql`
      SELECT t.id
        FROM tracked_signals t
        JOIN startup_invalid_stealth_targets x ON x.source_id = t.signal_id
       FOR UPDATE
    `);
    const sourceRefs = await tx.execute(drizzleSql`
      SELECT
        x.tracker_id,
        x.source_id,
        COUNT(t.id)::integer AS tracker_ref_count,
        COALESCE(
          ARRAY_AGG(t.id ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL),
          ARRAY[]::integer[]
        ) AS tracker_ids
      FROM startup_invalid_stealth_targets x
      LEFT JOIN tracked_signals t ON t.signal_id = x.source_id
      GROUP BY x.tracker_id, x.source_id
      ORDER BY x.tracker_id
    `);
    for (const row of sourceRefs.rows as Array<Record<string, unknown>>) {
      const trackerIds = Array.isArray(row.tracker_ids)
        ? row.tracker_ids.map(Number)
        : [];
      if (
        Number(row.tracker_ref_count) !== 1 ||
        trackerIds[0] !== Number(row.tracker_id)
      ) {
        throw new Error(
          `Stealth deletion correction source-reference preflight failed for source ${String(row.source_id)}: expected tracker ${String(row.tracker_id)}, found [${trackerIds.join(", ")}]`,
        );
      }
    }

    const countRows = (result: { rows: unknown[]; rowCount?: number | null }) =>
      Number(result.rowCount ?? result.rows.length);
    const relationExists = async (tableName: string): Promise<boolean> => {
      const result = await tx.execute(
        drizzleSql`SELECT to_regclass(${`public.${tableName}`}) IS NOT NULL AS present`,
      );
      return Boolean(
        (result.rows[0] as { present?: boolean } | undefined)?.present,
      );
    };
    const columnExists = async (tableName: string, column: string) => {
      const result = await tx.execute(drizzleSql`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = ${tableName}
             AND column_name = ${column}
        ) AS present
      `);
      return Boolean(
        (result.rows[0] as { present?: boolean } | undefined)?.present,
      );
    };
    const counts: Record<string, number> = {};
    const deleteByColumn = async (tableName: string, column: string) => {
      if (
        !(await relationExists(tableName)) ||
        !(await columnExists(tableName, column))
      ) {
        counts[tableName] = 0;
        return;
      }
      counts[tableName] = countRows(
        await tx.execute(
          drizzleSql.raw(`
            DELETE FROM ${tableName} d
             USING startup_invalid_stealth_targets x
             WHERE d.${column} = x.tracker_id
             RETURNING d.id
          `),
        ),
      );
    };

    // Tracker-owned ledgers must be removed before tracked_signals.
    for (const table of [
      "signal_trajectory_log",
      "signal_drawdown_extrema",
      "signal_trailing_events",
      "signal_trailing_shadow_events",
      "signal_profit_lock_shadow_events",
      "signal_health_events",
      "signal_cancel_outcomes",
    ]) {
      await deleteByColumn(table, "signal_id");
    }
    await deleteByColumn(
      "milestone_notification_deliveries",
      "tracked_signal_id",
    );
    await deleteByColumn("bu_stop_followup_snapshots", "tracked_signal_id");
    const deleteBySourceColumn = async (tableName: string, column: string) => {
      if (
        !(await relationExists(tableName)) ||
        !(await columnExists(tableName, column))
      ) {
        counts[tableName] = 0;
        return;
      }
      counts[tableName] = countRows(
        await tx.execute(
          drizzleSql.raw(`
            DELETE FROM ${tableName} d
             USING startup_invalid_stealth_targets x
             WHERE d.${column} = x.source_id
             RETURNING d.id
          `),
        ),
      );
    };

    if (await relationExists("altbullet_take_profit_shadow")) {
      counts.altbullet_take_profit_shadow = countRows(
        await tx.execute(drizzleSql`
          DELETE FROM altbullet_take_profit_shadow d
           USING startup_invalid_stealth_targets x
           WHERE d.tracked_signal_id = x.tracker_id
              OR d.signal_id = x.source_id
           RETURNING d.id
        `),
      );
    }
    if (await relationExists("pattern_decision_snapshots")) {
      if (await relationExists("pattern_backfill_candles")) {
        counts.pattern_backfill_candles = countRows(
          await tx.execute(drizzleSql`
            DELETE FROM pattern_backfill_candles c
             USING pattern_decision_snapshots d,
                   startup_invalid_stealth_targets x
             WHERE c.decision_snapshot_id = d.id
               AND (d.tracked_signal_id = x.tracker_id OR d.signal_id = x.source_id)
             RETURNING c.id
          `),
        );
      }
      counts.pattern_decision_snapshots = countRows(
        await tx.execute(drizzleSql`
          DELETE FROM pattern_decision_snapshots d
           USING startup_invalid_stealth_targets x
           WHERE d.tracked_signal_id = x.tracker_id OR d.signal_id = x.source_id
           RETURNING d.id
        `),
      );
    }
    await deleteBySourceColumn("altbullet_indicator_snapshots", "signal_id");
    await deleteBySourceColumn(
      "liq_cascade_candidate_observations",
      "signal_id",
    );
    await deleteBySourceColumn(
      "stealth_breakout_observations",
      "confirmation_signal_id",
    );

    // Remove only source-linked analytics, never aggregate reports.
    if (await relationExists("signal_whale_seeds")) {
      counts.signal_whale_seeds = countRows(
        await tx.execute(drizzleSql`
          DELETE FROM signal_whale_seeds d
           USING startup_invalid_stealth_targets x
           WHERE d.signal_id = x.source_id
           RETURNING d.id
        `),
      );
      if (await columnExists("signal_whale_seeds", "tracked_signal_id")) {
        counts.signal_whale_seeds_tracked = countRows(
          await tx.execute(drizzleSql`
            DELETE FROM signal_whale_seeds d
             USING startup_invalid_stealth_targets x
             WHERE d.tracked_signal_id = x.tracker_id
             RETURNING d.id
          `),
        );
      }
    }
    if (
      (await relationExists("prescan_telemetry_outbox")) &&
      (await columnExists("prescan_telemetry_outbox", "payload"))
    ) {
      counts.prescan_telemetry_outbox = countRows(
        await tx.execute(drizzleSql`
          DELETE FROM prescan_telemetry_outbox d
           USING startup_invalid_stealth_targets x
           WHERE (d.payload->>'signalId') ~ '^[0-9]+$'
             AND (d.payload->>'signalId')::bigint = x.source_id
              OR (d.payload->>'trackedSignalId') ~ '^[0-9]+$'
             AND (d.payload->>'trackedSignalId')::bigint = x.tracker_id
           RETURNING d.id
        `),
      );
    }

    // Telegram identities are exact: signal:<source>, and delimiter-bounded
    // position/milestone keys for the tracker. Never match by symbol.
    const telegramKeyPredicate = drizzleSql`
      d.dedup_key = ('signal:' || x.source_id::text)
      OR d.dedup_key ~ ('(^|:)position:' || x.tracker_id::text || '(:|$)')
      OR d.dedup_key ~ ('(^|:)milestone:(v3:)?' || x.tracker_id::text || '(:|$)')
    `;
    await tx.execute(drizzleSql`
      CREATE TEMP TABLE startup_invalid_stealth_photo_ids (id integer PRIMARY KEY)
      ON COMMIT DROP
    `);
    if (await relationExists("telegram_photo_deliveries")) {
      await tx.execute(drizzleSql`
        INSERT INTO startup_invalid_stealth_photo_ids (id)
        SELECT d.id
          FROM telegram_photo_deliveries d
          JOIN startup_invalid_stealth_targets x ON ${telegramKeyPredicate}
        ON CONFLICT DO NOTHING
      `);
    }
    if (await relationExists("telegram_delivery_attempt_audit")) {
      counts.telegram_delivery_attempt_audit = countRows(
        await tx.execute(drizzleSql`
          DELETE FROM telegram_delivery_attempt_audit a
           WHERE a.delivery_id IN (
                   SELECT id FROM startup_invalid_stealth_photo_ids
                 )
              OR EXISTS (
                   SELECT 1
                     FROM startup_invalid_stealth_targets x
                    WHERE a.dedup_key = ('signal:' || x.source_id::text)
                       OR a.dedup_key ~ ('(^|:)position:' || x.tracker_id::text || '(:|$)')
                       OR a.dedup_key ~ ('(^|:)milestone:(v3:)?' || x.tracker_id::text || '(:|$)')
                 )
           RETURNING a.id
        `),
      );
    }
    if (await relationExists("telegram_photo_deliveries")) {
      counts.telegram_photo_deliveries = countRows(
        await tx.execute(drizzleSql`
          DELETE FROM telegram_photo_deliveries d
           USING startup_invalid_stealth_photo_ids p
           WHERE d.id = p.id
           RETURNING d.id
        `),
      );
    }
    if (await relationExists("telegram_delivery_events")) {
      counts.telegram_delivery_events = countRows(
        await tx.execute(drizzleSql`
          DELETE FROM telegram_delivery_events d
           USING startup_invalid_stealth_targets x
           WHERE d.event_key = ('signal:' || x.source_id::text)
              OR d.event_key ~ ('(^|:)position:' || x.tracker_id::text || '(:|$)')
              OR d.event_key ~ ('(^|:)milestone:(v3:)?' || x.tracker_id::text || '(:|$)')
           RETURNING d.id
        `),
      );
    }

    // The arm is an exact parent of this correction and must be deleted before
    // the source signal because fired_signal_id references signals(id).
    counts.stealth_breakout_armed_setups = countRows(
      await tx.execute(drizzleSql`
        DELETE FROM stealth_breakout_armed_setups d
         USING startup_invalid_stealth_targets x
         WHERE d.id = x.arm_id
           AND d.symbol = x.symbol
           AND d.fired_signal_id = x.source_id
         RETURNING d.id
      `),
    );
    counts.tracked_signals = countRows(
      await tx.execute(drizzleSql`
        DELETE FROM tracked_signals d
         USING startup_invalid_stealth_targets x
         WHERE d.id = x.tracker_id
           AND d.signal_id = x.source_id
           AND d.symbol = x.symbol
           AND d.sentiment_key = 'stealth_breakout'
           AND d.stealth_detection_method = 'quiet_zone_breakout'
           AND d.status IN ('active', 'in_run')
         RETURNING d.id
      `),
    );
    counts.signals = countRows(
      await tx.execute(drizzleSql`
        DELETE FROM signals d
         USING startup_invalid_stealth_targets x
         WHERE d.id = x.source_id
           AND d.symbol = x.symbol
           AND d.sentiment_key = 'stealth_breakout'
           AND d.stealth_detection_method = 'quiet_zone_breakout'
         RETURNING d.id
      `),
    );
    if (
      counts.stealth_breakout_armed_setups !== targets.length ||
      counts.tracked_signals !== targets.length ||
      counts.signals !== targets.length
    ) {
      throw new Error(
        `Stealth deletion correction postcondition failed (${JSON.stringify(counts)})`,
      );
    }
    const remaining = await tx.execute(drizzleSql`
      SELECT
        (SELECT COUNT(*) FROM stealth_breakout_armed_setups a
          JOIN startup_invalid_stealth_targets x ON x.arm_id = a.id) +
        (SELECT COUNT(*) FROM tracked_signals t
          JOIN startup_invalid_stealth_targets x ON x.tracker_id = t.id) +
        (SELECT COUNT(*) FROM signals s
          JOIN startup_invalid_stealth_targets x ON x.source_id = s.id)
        AS remaining
    `);
    if (
      Number(
        (remaining.rows[0] as { remaining?: number } | undefined)?.remaining,
      ) !== 0
    ) {
      throw new Error(
        "Stealth deletion correction left an exact target parent row",
      );
    }
    logger.info(
      { targets: targets.length, ...counts },
      "Invalid Stealth quiet-zone trades deleted",
    );
  });
}

/**
 * The previous quiet-zone contract used a closed 1H cross as its live gate.
 * Those arms are not safe to carry across the 4H correction: a later 1H move
 * must never fire them.  Only non-terminal legacy arms are neutral-invalidated
 * here; fired history is deliberately immutable.
 */
async function invalidateLegacyStealthQuietZoneArms(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  return db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('stealth_quiet_zone_legacy_1h_invalidate_20260912'))`,
    );
    const result = await tx.execute(drizzleSql`
      UPDATE stealth_breakout_armed_setups
         SET status = 'invalidated',
             terminal_reason = 'legacy_1h_contract_superseded_by_4h',
             decision_at = NOW(),
             decision_json = COALESCE(decision_json, '{}'::jsonb) ||
               jsonb_build_object(
                 'status', 'invalidated',
                 'reason', 'legacy_1h_contract_superseded_by_4h',
                 'timeframe', '4h',
                 'breakoutGate', 'closed_4h_candle_breaks_frozen_4h_resistance',
                 'evaluatedAt', (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
               ),
             updated_at = NOW()
       WHERE level_source = 'stealth_legacy'
         AND (
           experiment_version = 'legacy-quiet-zone-restored-v1'
           OR experiment_version IS NULL
           OR decision_json->>'breakoutGate' IS DISTINCT FROM
             'closed_4h_candle_breaks_frozen_4h_resistance'
         )
         AND status IN ('armed', 'qualified', 'firing')
      RETURNING id
    `);
    const count = Number((result as any).rowCount ?? result.rows.length);
    logger.info({ count }, "Legacy 1H Stealth arms invalidated at startup");
    return count;
  });
}

async function ensurePlmDecisionSnapshotSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('plm_decision_snapshot_schema'))`,
    );
    for (const table of ["signals", "tracked_signals"] as const) {
      await tx.execute(
        drizzleSql.raw(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS entry_price_3h real`,
        ),
      );
      await tx.execute(
        drizzleSql.raw(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS entry_price_3h_provenance text`,
        ),
      );
      await tx.execute(
        drizzleSql.raw(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS plm_p24h_cap_18_pass boolean`,
        ),
      );
      await tx.execute(
        drizzleSql.raw(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS plm_fut_taker_shadow text`,
        ),
      );
      await tx.execute(
        drizzleSql.raw(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS plm_oi30m_shadow text`,
        ),
      );
      await tx.execute(
        drizzleSql.raw(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS entry_score_breakdown text`,
        ),
      );
      await tx.execute(
        drizzleSql.raw(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS entry_grade_reason text`,
        ),
      );
    }
  });
}

/**
 * Calculator archives are a required durable feature, so their schema cannot
 * depend on optional heavy startup maintenance. The watcher starts only after
 * this gate succeeds.
 */
async function ensureTradeCalculatorSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('trade_calculator_schema'))`,
    );
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS dashboard_users (
        id            SERIAL PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
        approved_at   TIMESTAMP,
        last_login_at TIMESTAMP,
        last_activity_at TIMESTAMP,
        subscribed_until TIMESTAMP
      )
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE dashboard_users
      ADD COLUMN IF NOT EXISTS chat_id TEXT
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE dashboard_users
      ADD COLUMN IF NOT EXISTS telegram_username TEXT
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS trade_calculator_settings (
        user_id            INTEGER PRIMARY KEY REFERENCES dashboard_users(id) ON DELETE CASCADE,
        deposit_usdt       REAL NOT NULL DEFAULT 1000,
        leverage           REAL NOT NULL DEFAULT 10,
        allocation_percent REAL NOT NULL DEFAULT 10,
        commission_percent REAL NOT NULL DEFAULT 0.1,
        reinvest           BOOLEAN NOT NULL DEFAULT false,
        created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS trade_calculator_monthly (
        id                  SERIAL PRIMARY KEY,
        user_id             INTEGER NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
        month               TEXT NOT NULL,
        deposit_usdt         REAL NOT NULL,
        leverage             REAL NOT NULL,
        allocation_percent   REAL NOT NULL,
        commission_percent   REAL NOT NULL,
        reinvest             BOOLEAN NOT NULL DEFAULT false,
        gross_pnl_usdt       REAL NOT NULL DEFAULT 0,
        net_pnl_usdt         REAL NOT NULL DEFAULT 0,
        closed_trades        INTEGER NOT NULL DEFAULT 0,
        profit_trades        INTEGER NOT NULL DEFAULT 0,
        loss_trades          INTEGER NOT NULL DEFAULT 0,
        bu_stop_trades        INTEGER NOT NULL DEFAULT 0,
        breakeven_trades     INTEGER NOT NULL DEFAULT 0,
        expired_trades       INTEGER NOT NULL DEFAULT 0,
        cancelled_signals    INTEGER NOT NULL DEFAULT 0,
        period_closed_at     TIMESTAMP,
        calculated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE trade_calculator_monthly
      ADD COLUMN IF NOT EXISTS period_closed_at TIMESTAMP
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE trade_calculator_monthly
      ADD COLUMN IF NOT EXISTS expired_trades INTEGER NOT NULL DEFAULT 0
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE trade_calculator_monthly
      ADD COLUMN IF NOT EXISTS bu_stop_trades INTEGER NOT NULL DEFAULT 0
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE trade_calculator_monthly
      DROP CONSTRAINT IF EXISTS trade_calculator_monthly_counts_check
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE trade_calculator_monthly
      ADD CONSTRAINT trade_calculator_monthly_counts_check CHECK (
        closed_trades >= 0
        AND profit_trades >= 0
        AND loss_trades >= 0
        AND bu_stop_trades >= 0
        AND breakeven_trades >= 0
        AND expired_trades >= 0
        AND cancelled_signals >= 0
        AND closed_trades = profit_trades + loss_trades + bu_stop_trades + breakeven_trades + expired_trades
      )
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS dashboard_password_resets (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL,
        code       TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL,
        used       BOOLEAN NOT NULL DEFAULT FALSE
      )
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS dashboard_password_resets_lookup_idx
      ON dashboard_password_resets (user_id, code, used, expires_at)
    `);
    await tx.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS trade_calculator_monthly_user_month_unique
      ON trade_calculator_monthly (user_id, month)
    `);
  });
}

/**
 * Telemetry writes retry after ambiguous database timeouts. The same immutable
 * cycle payload must therefore be idempotent before any scanner can enqueue it.
 *
 * A transaction-scoped advisory lock serializes rolling-deploy workers; table
 * locks prevent legacy writers from inserting duplicates between cleanup and
 * unique-index creation.
 */
async function ensurePrescanTelemetryIdempotencySchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('prescan_telemetry_idempotency_schema'))`,
    );
    // These tables historically evolved in the broad, non-blocking startup
    // migration. Create/align the minimal telemetry schema here so a fresh
    // database reaches the idempotency transaction instead of exiting early.
    await tx.execute(drizzleSql`CREATE TABLE IF NOT EXISTS prescan_history (
    id serial PRIMARY KEY,
    symbol text NOT NULL,
    ts timestamp NOT NULL DEFAULT now(),
    cycle_count integer,
    rank integer,
    score real,
    price_24h real,
    price_1h real,
    oi_30m real,
    oi_1h real,
    oi_4h real,
    oi_24h real,
    vol_mult real,
    cvd_30m boolean,
    cvd_1h boolean,
    net_buy_pct real,
    spot_taker_net_buy real,
    oi_accel_30m real,
    fut_spot_ratio real,
    whale_index real,
    snf_1h real,
    ob_ratio real
  )`);
    await tx.execute(
      drizzleSql`ALTER TABLE prescan_history
      ADD COLUMN IF NOT EXISTS net_buy_pct real,
      ADD COLUMN IF NOT EXISTS spot_taker_net_buy real,
      ADD COLUMN IF NOT EXISTS oi_accel_30m real,
      ADD COLUMN IF NOT EXISTS fut_spot_ratio real,
      ADD COLUMN IF NOT EXISTS whale_index real,
      ADD COLUMN IF NOT EXISTS snf_1h real,
      ADD COLUMN IF NOT EXISTS ob_ratio real`,
    );
    await tx.execute(drizzleSql`CREATE TABLE IF NOT EXISTS prescan_snapshots (
    id serial PRIMARY KEY,
    symbol text NOT NULL,
    cycle_at timestamp NOT NULL,
    p24h real,
    p1h real,
    price real,
    oi30m real,
    oi1h real,
    oi4h real,
    vol_mult real,
    spot_vol_usd_24h real,
    fut_spot_ratio real,
    whale_index real,
    snf_1h real,
    funding_rate real,
    ob_ratio real,
    cvd_30m boolean,
    cvd_1h boolean,
    cvd_4h boolean,
    cycles_in_pool integer
  )`);
    await tx.execute(
      drizzleSql`ALTER TABLE prescan_snapshots
      ADD COLUMN IF NOT EXISTS oi1h real,
      ADD COLUMN IF NOT EXISTS spot_vol_usd_24h real,
      ADD COLUMN IF NOT EXISTS fut_spot_ratio real,
      ADD COLUMN IF NOT EXISTS snf_1h real,
      ADD COLUMN IF NOT EXISTS funding_rate real,
      ADD COLUMN IF NOT EXISTS ob_ratio real,
      ADD COLUMN IF NOT EXISTS cvd_1h boolean`,
    );
    await tx.execute(drizzleSql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'prescan_snapshots' AND column_name = 'cvd30m'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'prescan_snapshots' AND column_name = 'cvd_30m'
      ) THEN
        ALTER TABLE prescan_snapshots RENAME COLUMN cvd30m TO cvd_30m;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'prescan_snapshots' AND column_name = 'cvd4h'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'prescan_snapshots' AND column_name = 'cvd_4h'
      ) THEN
        ALTER TABLE prescan_snapshots RENAME COLUMN cvd4h TO cvd_4h;
      END IF;
    END $$
  `);
    await tx.execute(
      drizzleSql`LOCK TABLE prescan_history, prescan_snapshots IN SHARE ROW EXCLUSIVE MODE`,
    );
    await tx.execute(drizzleSql`
      DELETE FROM prescan_history older
      USING prescan_history newer
      WHERE older.id < newer.id
        AND older.symbol = newer.symbol
        AND older.ts = newer.ts
    `);
    await tx.execute(drizzleSql`
      DELETE FROM prescan_snapshots older
      USING prescan_snapshots newer
      WHERE older.id < newer.id
        AND older.symbol = newer.symbol
        AND older.cycle_at = newer.cycle_at
    `);
    await tx.execute(
      drizzleSql`CREATE UNIQUE INDEX IF NOT EXISTS prescan_history_symbol_ts_unique
        ON prescan_history (symbol, ts)`,
    );
    await tx.execute(
      drizzleSql`CREATE UNIQUE INDEX IF NOT EXISTS pss_symbol_cycle_unique
        ON prescan_snapshots (symbol, cycle_at)`,
    );
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS prescan_telemetry_outbox (
        id              serial PRIMARY KEY,
        dedup_key       text NOT NULL,
        kind            text NOT NULL,
        payload         jsonb NOT NULL,
        status          text NOT NULL DEFAULT 'ready',
        next_attempt_at timestamp NOT NULL DEFAULT now(),
        lease_until     timestamp,
        claim_token     text,
        attempts        integer NOT NULL DEFAULT 0,
        last_error      text,
        created_at      timestamp NOT NULL DEFAULT now(),
        updated_at      timestamp NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS prescan_telemetry_outbox_dedup_unique
      ON prescan_telemetry_outbox (dedup_key)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS prescan_telemetry_outbox_due_idx
      ON prescan_telemetry_outbox (status, next_attempt_at, lease_until)
    `);
  });
}

/**
 * Required immutable audit boundary. This is intentionally a startup gate:
 * tracker writes may proceed if an optional snapshot write fails, but the
 * process must not begin a new operational lifetime without its schema.
 */
async function ensurePatternDecisionHistorySchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('pattern_decision_history_schema'))`,
    );
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS pattern_decision_snapshots (
        id serial PRIMARY KEY,
        event_key text NOT NULL,
        tracked_signal_id integer,
        missed_signal_id integer,
        signal_id integer,
        symbol text NOT NULL,
        pattern_key text NOT NULL,
        decision_kind text NOT NULL,
        decision_reason text,
        decision_at timestamptz NOT NULL,
        is_short boolean NOT NULL DEFAULT false,
        entry_price real,
        entry_metrics jsonb NOT NULL,
        provenance jsonb NOT NULL,
        completeness jsonb NOT NULL,
        source text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        trajectory_status text NOT NULL DEFAULT 'pending'
          CHECK (trajectory_status IN ('pending', 'partial', 'complete', 'retry', 'unavailable')),
        trajectory_attempts integer NOT NULL DEFAULT 0,
        trajectory_last_attempt_at timestamptz,
        trajectory_next_attempt_at timestamptz,
        trajectory_completed_at timestamptz,
        trajectory_last_error text,
        trajectory_candle_count integer NOT NULL DEFAULT 0,
        trajectory_claim_token text,
        trajectory_claimed_at timestamptz,
        trajectory_claim_expires_at timestamptz,
        CONSTRAINT pattern_decision_snapshots_decision_kind_allowed
          CHECK (decision_kind IN ('fired', 'missed', 'rejected', 'blocked', 'watching', 'expired', 'deferred')),
        CONSTRAINT pattern_decision_snapshots_decision_source_link
          CHECK (
            (
              decision_kind <> 'fired'
              OR source NOT LIKE 'tracked_signals%'
              OR tracked_signal_id IS NOT NULL
            )
            AND (decision_kind <> 'missed' OR missed_signal_id IS NOT NULL)
          )
      )
    `);
    await tx.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS pattern_decision_snapshots_event_key_unique
      ON pattern_decision_snapshots (event_key)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS pattern_decision_snapshots_decision_at_idx
      ON pattern_decision_snapshots (decision_at)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS pattern_decision_snapshots_tracked_signal_idx
      ON pattern_decision_snapshots (tracked_signal_id)
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE pattern_decision_snapshots
        ADD COLUMN IF NOT EXISTS decision_reason text
    `);
    await tx.execute(drizzleSql`
      DO $$
      DECLARE constraint_name text;
      BEGIN
        FOR constraint_name IN
          SELECT c.conname
          FROM pg_constraint c
          WHERE c.conrelid = 'pattern_decision_snapshots'::regclass
            AND c.contype = 'c'
            AND pg_get_constraintdef(c.oid) LIKE '%decision_kind%'
            AND c.conname NOT IN (
              'pattern_decision_snapshots_decision_kind_allowed',
              'pattern_decision_snapshots_decision_source_link'
            )
        LOOP
          EXECUTE format('ALTER TABLE pattern_decision_snapshots DROP CONSTRAINT IF EXISTS %I', constraint_name);
        END LOOP;
      END $$;
    `);
    await tx.execute(drizzleSql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'pattern_decision_snapshots'::regclass
            AND conname = 'pattern_decision_snapshots_decision_kind_allowed'
        ) THEN
          ALTER TABLE pattern_decision_snapshots
            ADD CONSTRAINT pattern_decision_snapshots_decision_kind_allowed
            CHECK (decision_kind IN ('fired', 'missed', 'rejected', 'blocked', 'watching', 'expired', 'deferred'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'pattern_decision_snapshots'::regclass
            AND conname = 'pattern_decision_snapshots_decision_source_link'
        ) THEN
          ALTER TABLE pattern_decision_snapshots
            ADD CONSTRAINT pattern_decision_snapshots_decision_source_link
            CHECK (
              (
                decision_kind <> 'fired'
                OR source NOT LIKE 'tracked_signals%'
                OR tracked_signal_id IS NOT NULL
              )
              AND (decision_kind <> 'missed' OR missed_signal_id IS NOT NULL)
            );
        END IF;
      END $$;
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE pattern_decision_snapshots
        ADD COLUMN IF NOT EXISTS trajectory_status text NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS trajectory_attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS trajectory_last_attempt_at timestamptz,
        ADD COLUMN IF NOT EXISTS trajectory_next_attempt_at timestamptz,
        ADD COLUMN IF NOT EXISTS trajectory_completed_at timestamptz,
        ADD COLUMN IF NOT EXISTS trajectory_last_error text,
        ADD COLUMN IF NOT EXISTS trajectory_candle_count integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS trajectory_claim_token text,
        ADD COLUMN IF NOT EXISTS trajectory_claimed_at timestamptz,
        ADD COLUMN IF NOT EXISTS trajectory_claim_expires_at timestamptz
    `);
    await tx.execute(drizzleSql`
      UPDATE pattern_decision_snapshots
      SET trajectory_status = 'pending'
      WHERE trajectory_status IS NULL
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS pattern_decision_snapshots_trajectory_due_idx
      ON pattern_decision_snapshots (trajectory_status, trajectory_next_attempt_at)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS pattern_decision_snapshots_trajectory_claim_idx
      ON pattern_decision_snapshots (trajectory_claim_expires_at)
    `);
    await tx.execute(drizzleSql`
      UPDATE pattern_decision_snapshots
      SET trajectory_status = 'unavailable',
          trajectory_next_attempt_at = NULL,
          trajectory_last_error = 'entry_price_not_recorded',
          provenance = jsonb_set(
            COALESCE(provenance, '{}'::jsonb),
            '{entry_price}',
            '"not_recorded"'::jsonb,
            true
          ),
          completeness = jsonb_set(
            COALESCE(completeness, '{}'::jsonb),
            '{entryPrice}',
            'false'::jsonb,
            true
          )
      WHERE source = 'liq_cascade_fire_reject'
        AND (entry_price IS NULL OR entry_price <= 0)
        AND (
          trajectory_status <> 'unavailable'
          OR trajectory_last_error IS DISTINCT FROM 'entry_price_not_recorded'
          OR completeness->>'entryPrice' IS DISTINCT FROM 'false'
        )
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS pattern_backfill_candles (
        id serial PRIMARY KEY,
        decision_snapshot_id integer NOT NULL REFERENCES pattern_decision_snapshots(id),
        interval text NOT NULL CHECK (interval = '15m'),
        candle_at timestamptz NOT NULL,
        open real NOT NULL,
        high real NOT NULL,
        low real NOT NULL,
        close real NOT NULL,
        volume real,
        source text NOT NULL,
        fetched_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS pattern_backfill_candles_snapshot_candle_unique
      ON pattern_backfill_candles (decision_snapshot_id, candle_at)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS pattern_backfill_candles_snapshot_interval_idx
      ON pattern_backfill_candles (decision_snapshot_id, interval)
    `);
  });
}

async function ensureLiqCascadeObservationSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('liq_cascade_observation_schema'))`,
    );
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS liq_cascade_candidate_observations (
        id bigserial PRIMARY KEY,
        event_key text NOT NULL,
        watch_id integer NOT NULL,
        signal_id integer,
        symbol text NOT NULL,
        detected_at timestamptz NOT NULL,
        observed_at timestamptz NOT NULL,
        bucket_at timestamptz NOT NULL,
        stage text NOT NULL CHECK (stage IN ('watching', 'rejected', 'fired', 'expired')),
        reason text,
        price real,
        metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS liq_cascade_candidate_observations_event_unique
      ON liq_cascade_candidate_observations (event_key)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS liq_cascade_candidate_observations_watch_time_idx
      ON liq_cascade_candidate_observations (watch_id, observed_at)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS liq_cascade_candidate_observations_stage_time_idx
      ON liq_cascade_candidate_observations (stage, observed_at)
    `);
  });
}

async function ensurePostCloseFollowupSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('post_close_followup_schema'))`,
    );
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS bu_stop_followup_snapshots (
        id                serial PRIMARY KEY,
        tracked_signal_id integer NOT NULL,
        symbol            text NOT NULL,
        status            text NOT NULL DEFAULT 'bu_stop',
        closed_at         timestamp,
        exit_price        real,
        is_short          boolean NOT NULL DEFAULT false,
        hour_after_close  integer NOT NULL,
        observed_at       timestamptz NOT NULL,
        price             real NOT NULL,
        move_pct          real NOT NULL
      )
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE bu_stop_followup_snapshots
        ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'bu_stop'
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE bu_stop_followup_snapshots
        ADD COLUMN IF NOT EXISTS closed_at timestamp
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE bu_stop_followup_snapshots
        ADD COLUMN IF NOT EXISTS exit_price real
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE bu_stop_followup_snapshots
        ADD COLUMN IF NOT EXISTS is_short boolean NOT NULL DEFAULT false
    `);
    await tx.execute(drizzleSql`
      UPDATE bu_stop_followup_snapshots bfs
      SET status = ts.status::text,
          closed_at = COALESCE(bfs.closed_at, ts.closed_at),
          exit_price = COALESCE(bfs.exit_price, ts.exit_price),
          is_short = ts.is_short
      FROM tracked_signals ts
      WHERE bfs.tracked_signal_id = ts.id
        AND (
          bfs.closed_at IS NULL
          OR bfs.exit_price IS NULL
          OR bfs.is_short IS DISTINCT FROM ts.is_short
        )
    `);
    await tx.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS bu_stop_followup_signal_hour_uniq
        ON bu_stop_followup_snapshots (tracked_signal_id, hour_after_close)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS bu_stop_followup_observed_at_idx
        ON bu_stop_followup_snapshots (observed_at)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS bu_stop_followup_symbol_idx
        ON bu_stop_followup_snapshots (symbol)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS bu_stop_followup_status_closed_idx
        ON bu_stop_followup_snapshots (status, closed_at)
    `);
  });
}

async function runStartupMigration() {
  try {
    // Добавляем колонки scanner_last_scan_at / scanner_scan_started_at если ещё нет (идемпотентно)
    await db.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_last_scan_at TIMESTAMP`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_scan_started_at TIMESTAMP`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_last_scan_duration_ms INTEGER`,
    );
    await db.execute(drizzleSql`
      UPDATE settings
      SET scanner_last_scan_duration_ms = GREATEST(
        0,
        (EXTRACT(EPOCH FROM (scanner_last_scan_at - scanner_scan_started_at)) * 1000)::INTEGER
      )
      WHERE scanner_last_scan_duration_ms IS NULL
        AND scanner_last_scan_at IS NOT NULL
        AND scanner_scan_started_at IS NOT NULL
        AND scanner_last_scan_at >= scanner_scan_started_at
    `);
    await db.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_failure_at TIMESTAMP`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_failure_reason TEXT`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_failure_diagnostics_json TEXT`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS scanner_lease_expected_expiry_at TIMESTAMP`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS last_watchdog_alert_at TIMESTAMP`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS last_manual_check_sent_at TIMESTAMP`,
    );

    // CoinGlass liquidation-данные для liq_cascade_watch (идемпотентно)
    await db.execute(
      drizzleSql`ALTER TABLE liq_cascade_watch ADD COLUMN IF NOT EXISTS cycle_count_at_detect integer`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE liq_cascade_watch ADD COLUMN IF NOT EXISTS long_liq1h_at_detect real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE liq_cascade_watch ADD COLUMN IF NOT EXISTS long_liq4h_at_detect real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE liq_cascade_watch ADD COLUMN IF NOT EXISTS long_liq24h_at_detect real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE liq_cascade_watch ADD COLUMN IF NOT EXISTS current_long_liq1h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE liq_cascade_watch ADD COLUMN IF NOT EXISTS liq_exhausted boolean`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE liq_cascade_watch ADD COLUMN IF NOT EXISTS global_long_pct real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE liq_cascade_watch ADD COLUMN IF NOT EXISTS large_bid_usd real`,
    );

    // Индивидуальные стоп/тейки по Liquidation Heatmap (идемпотентно)
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS stop_loss_price real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS stop_loss_pct real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS stop_source text`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS take_targets jsonb`,
    );

    // 2026-10-10: Liquidation Cascade stop is exactly 10%. Align still-open rows
    // (idempotent; closed rows and their recorded outcomes are never touched).
    await db.execute(
      drizzleSql`UPDATE tracked_signals
        SET stop_loss_pct = 10,
            stop_loss_price = entry_price * 0.90,
            stop_source = 'pattern'
        WHERE sentiment_key = 'liquidation_cascade'
          AND status = 'active'
          AND entry_price > 0
          AND (stop_loss_pct IS DISTINCT FROM 10)`,
    );

    // Универсальные метрики входа (2026-07-15) + пер-токенный Whale Index (идемпотентно)
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_rsi_1h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_funding_rate real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_btc_24h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_whale_index real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_global_long_pct real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_metrics_provenance jsonb`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS impulse_decision_metrics jsonb`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS decision_metrics jsonb`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_price_3h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_price_3h_provenance text`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS plm_p24h_cap_18_pass boolean`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_score_breakdown text`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_grade_reason text`,
    );

    // Spot taker / net-buy метрики (2026-07-15) — пишутся для ВСЕХ паттернов (идемпотентно)
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_spot_taker_net_buy real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_spot_net_buy_1h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_spot_net_buy_4h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_spot_net_buy_24h real`,
    );

    // CVD 15m — последняя 1 × 15m свеча (2026-07-29)
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_cvd_15m boolean`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE signals ADD COLUMN IF NOT EXISTS entry_cvd_15m boolean`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE signals ADD COLUMN IF NOT EXISTS telegram_alert_queued boolean NOT NULL DEFAULT true`,
    );

    // Bid Wall — CoinGlass large limit orders (2026-07-29)
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS large_bid_usd real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS large_bid_nearest_pct real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS large_bid_order_count integer`,
    );
    // Spot Bid Wall — CoinGlass spot large limit orders (2026-07-29)
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS spot_bid_usd real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS spot_bid_nearest_pct real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS spot_bid_order_count integer`,
    );
    // Sell Wall — CoinGlass futures large ask orders (2026-08-01)
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS large_ask_usd real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS large_ask_nearest_pct real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS large_ask_order_count integer`,
    );
    // Spot Sell Wall — CoinGlass spot large ask orders (2026-08-01)
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS spot_ask_usd real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS spot_ask_nearest_pct real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS spot_ask_order_count integer`,
    );

    // growth_leader_log — создаём таблицу если не существует (продакшн Neon не получал drizzle push)
    await db.execute(drizzleSql`CREATE TABLE IF NOT EXISTS growth_leader_log (
      id              serial PRIMARY KEY,
      logged_at       timestamp NOT NULL DEFAULT now(),
      symbol          text NOT NULL,
      rank            integer,
      price           real,
      price_24h       real,
      price_1h        real,
      growth_from_entry real,
      cycle_count     integer,
      first_seen_at   real,
      layers          text[],
      oi_30m          real,
      oi_1h           real,
      oi_4h           real,
      cvd_1h          boolean,
      cvd_30m         boolean,
      spot_vol_mult   real,
      vol_mult        real,
      source          text NOT NULL DEFAULT 'scan',
      entry_price     real,
      entry_price_24h real,
      entry_oi_30m    real,
      entry_oi_1h     real,
      entry_oi_4h     real
    )`);
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS growth_leader_log_logged_at_idx ON growth_leader_log (logged_at)`,
    );
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS growth_leader_log_symbol_idx   ON growth_leader_log (symbol)`,
    );
    // Колонки entry_* — добавляем если таблица уже существовала без них
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS entry_price real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS entry_price_24h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS entry_oi_30m real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS entry_oi_1h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS entry_oi_4h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS net_buy_pct real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS spot_taker_buy_usd real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS spot_taker_sell_usd real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS spot_fp_buy_pct real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS matched_pattern text`,
    );
    // Entry snapshot при входе в prescan (2026-07-31)
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS entry_ob_ratio real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS entry_whale_index real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS entry_snf_1h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS entry_whale_index real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS entry_snf_1h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS first_whale_index real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS first_snf_1h real`,
    );
    // ПРИМЕЧАНИЕ: колонки growth_leader_log v1/v2 управляются через Drizzle migration 0002.

    // signal_pre_growth — ретроснимки T-1/2/4/12ч ДО момента выстрела сигнала.
    // Заполняется автоматически при каждом trackSignal "new" (fire-and-forget).
    // archetype / archetype_conf — результат archetype-detector FastAPI на момент выстрела.
    await db.execute(drizzleSql`CREATE TABLE IF NOT EXISTS signal_pre_growth (
      id            serial PRIMARY KEY,
      symbol        text    NOT NULL,
      fire_time     timestamptz NOT NULL,
      hours_before  integer NOT NULL,
      snapshot_time timestamptz NOT NULL,
      sentiment_key  text,
      archetype     text,
      archetype_conf integer,
      price         real,
      price_1h      real,
      price_3h      real,
      price_4h      real,
      price_24h     real,
      oi_30m        real,
      oi_prev_30m   real,
      oi_1h         real,
      oi_prev_1h    real,
      oi_4h         real,
      vol_mult      real,
      cvd_1h        boolean,
      cvd_1h_ratio  real,
      cvd_30m       boolean,
      cvd_30m_ratio real,
      net_buy_pct   real,
      spot_net_pct  real,
      spot_buy_usd  real,
      spot_sell_usd real,
      funding       real,
      created_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (symbol, fire_time, hours_before)
    )`);
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS signal_pre_growth_symbol_idx ON signal_pre_growth (symbol)`,
    );
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS signal_pre_growth_fire_time_idx ON signal_pre_growth (fire_time DESC)`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE signal_pre_growth ADD COLUMN IF NOT EXISTS sentiment_key text`,
    );

    // Одноразовый фикс: заполняем alpha_score для открытых позиций где он NULL.
    // Идемпотентно: WHERE alpha_score IS NULL — повторный запуск no-op.
    await db.execute(drizzleSql`
      UPDATE tracked_signals
      SET alpha_score = 6
      WHERE alpha_score IS NULL
        AND status IN ('active', 'in_run')
    `);

    // Growth Leader Log: снимки топ-50 гейнеров каждый скан-цикл (идемпотентно)
    await db.execute(drizzleSql`CREATE TABLE IF NOT EXISTS growth_leader_log (
      id serial PRIMARY KEY,
      logged_at timestamp NOT NULL DEFAULT now(),
      symbol text NOT NULL,
      rank integer,
      price real,
      price_24h real,
      price_1h real,
      growth_from_entry real,
      cycle_count integer,
      first_seen_at real,
      layers text[],
      oi_30m real,
      oi_1h real,
      oi_4h real,
      cvd_1h boolean,
      cvd_30m boolean,
      spot_vol_mult real,
      vol_mult real,
      source text NOT NULL DEFAULT 'scan'
    )`);
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS growth_leader_log_logged_at_idx ON growth_leader_log (logged_at)`,
    );
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS growth_leader_log_symbol_idx ON growth_leader_log (symbol)`,
    );

    // first_oi_* в prescan_tracker: снимок OI при первом входе токена в prescan (идемпотентно)
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS first_oi_30m real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS first_oi_1h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS first_oi_4h real`,
    );

    // pattern_debug_log — агрегированные счётчики checked/passed/rejectedAt по паттернам
    // за каждый скан-цикл. Используется в /api/scanner/pattern-debug/history.
    await db.execute(drizzleSql`CREATE TABLE IF NOT EXISTS pattern_debug_log (
      id serial PRIMARY KEY,
      pattern text NOT NULL,
      cycle_number integer,
      checked integer NOT NULL,
      passed integer NOT NULL,
      rejected_at text,
      symbol text,
      cvd_diag text,
      logged_at timestamp NOT NULL DEFAULT now()
    )`);
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS pattern_debug_pattern_idx ON pattern_debug_log (pattern)`,
    );
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS pattern_debug_logged_at_idx ON pattern_debug_log (logged_at)`,
    );
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS pattern_debug_symbol_idx ON pattern_debug_log (symbol)`,
    );
    // Сброс устаревших PDB-счётчиков liquidation_cascade (до редизайна 2026-07-19):
    // старые лейблы no_1h_dump/oi_pass_blocks из кода до pool-redesign засоряли UI.
    // Идемпотентно: удаляем только строки старше 2026-07-19 09:00 UTC.
    await db.execute(
      drizzleSql`DELETE FROM pattern_debug_log WHERE pattern = 'liquidation_cascade' AND logged_at < '2026-07-19 09:00:00'`,
    );

    // BA OI routes are entry-source diagnostics, not standalone patterns.
    // Their path remains persisted on tracked signals for calibration.
    await db.execute(drizzleSql`DELETE FROM pattern_debug_log WHERE pattern IN (
      'bullish_accumulation_fresh_oi30m',
      'bullish_accumulation_extended_oi30m',
      'bullish_accumulation_transition_oi30m',
      'bullish_accumulation_slow_multitf'
    )`);

    // Удаляем всю историю PDB для удалённых паттернов: они больше не в коде,
    // их исторические строки засоряли PDB-дашборд. Идемпотентно.
    await db.execute(drizzleSql`DELETE FROM pattern_debug_log WHERE pattern IN (
      'liquidation_cascade',
      'liq_magnet_squeeze','exchange_outflow_accum','oversold_reversal',
      'smart_money_divergence','4h_momentum','oi1h_breakout',
      'oi4h_silent_accum','quiet_trend_rider',
      'spot_momentum_reversal','spot_vol_surge','impulse_breakout',
      'trend_accumulation','dip_accumulation','spot_trend_accumulation','spot_divergence','accumulation_breakout',
      'quiet_oi_accumulation','volume_taker','spot_absorption','early_vol_oi',
      'spot_oi4h_build','short_squeeze','spot_taker_lead','spot_vol_breakout',
      'oi24h_accumulation','daily_oi_accum_experiment',
      'silent_whale','hidden_accumulation','whale_watch_spot','anomaly','mexc_pump',
      'aggressive_breakout','bear_trap','distribution','bearish_pressure',
      'volume_breakout','volume_breakout_futures',
      'volume_breakout_quiet','volume_breakout_mover','volume_breakout_spot',
      'spot_vol_accumulation','4h_pullback_continuation','whale_alert'
    )`);

    // scan_reject_log: per-symbol per-pattern причины отклонения (TTL 7 дней)
    await db.execute(drizzleSql`CREATE TABLE IF NOT EXISTS scan_reject_log (
      id serial PRIMARY KEY,
      cycle_at timestamptz NOT NULL,
      symbol text NOT NULL,
      pattern text NOT NULL,
      reason text NOT NULL,
      oi30m real,
      vol_mult real,
      price24h real,
      prescan_cycles integer
    )`);
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS scan_reject_log_sym_idx ON scan_reject_log (symbol, cycle_at)`,
    );
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS scan_reject_log_cycle_idx ON scan_reject_log (cycle_at)`,
    );
    await db.execute(
      drizzleSql`DELETE FROM scan_reject_log WHERE cycle_at < NOW() - INTERVAL '7 days'`,
    );

    // Futures vs Spot Volume (CoinGlass /api/futures_spot_volume_ratio, Binance+OKX+Bybit)
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS fut_vol_usd_24h   real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS spot_vol_usd_24h  real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS fut_spot_ratio     real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS fut_vol_pct_mcap  real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS spot_vol_pct_mcap real`,
    );
    // last_whale_index: per-token CoinGlass Whale Index (Binance futures, 4h); обновляется батчем раз в скан-цикл для OI Watch + топ prescan
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS last_whale_index real`,
    );
  } catch (err) {
    logger.warn({ err }, "Startup migration Part 1: ошибка (non-critical)");
  }

  // ── Part 2: Forward-accumulation tables — отдельный try/catch чтобы сбой Part 1 не блокировал ──
  try {
    await db.execute(drizzleSql`CREATE TABLE IF NOT EXISTS telegram_updates (
      update_id    bigint PRIMARY KEY,
      status       text NOT NULL DEFAULT 'processing',
      claim_token  text,
      received_at  timestamp NOT NULL DEFAULT now(),
      completed_at timestamp,
      last_error   text
    )`);
    await db.execute(
      drizzleSql`ALTER TABLE telegram_updates ADD COLUMN IF NOT EXISTS claim_token text`,
    );
    await db.execute(drizzleSql`
      UPDATE telegram_updates
      SET status = 'completed',
          completed_at = COALESCE(completed_at, NOW())
      WHERE status = 'completion_pending'
    `);
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS telegram_updates_received_at_idx ON telegram_updates (received_at)`,
    );
    await db.execute(
      drizzleSql`DELETE FROM telegram_updates WHERE status = 'completed' AND completed_at < NOW() - INTERVAL '30 days'`,
    );

    // periodic_collection_log: лог запусков/ошибок для data-accumulation jobs
    await db.execute(drizzleSql`CREATE TABLE IF NOT EXISTS periodic_collection_log (
      id             serial PRIMARY KEY,
      job_name       text      NOT NULL,
      started_at     timestamp NOT NULL DEFAULT now(),
      finished_at    timestamp,
      records_written integer,
      error          text
    )`);
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS periodic_log_job_idx ON periodic_collection_log (job_name, started_at DESC)`,
    );

    // cg_liq_heatmap_snapshot: JSONB-снимки CoinGlass (совместимо с историческим backfill)
    await db.execute(drizzleSql`CREATE TABLE IF NOT EXISTS cg_liq_heatmap_snapshot (
      id           serial PRIMARY KEY,
      symbol       text   NOT NULL,
      range        text   NOT NULL DEFAULT '3d',
       snapshot_at  timestamptz NOT NULL,
       y_axis       jsonb,
       liq_leverage_data jsonb,
       price_candlesticks jsonb,
       created_at   timestamp DEFAULT now(),
       CONSTRAINT cg_liq_heatmap_dedup UNIQUE (symbol, range, snapshot_at)
    )`);
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS cg_heatmap_snap_symbol_idx ON cg_liq_heatmap_snapshot (symbol, snapshot_at DESC)`,
    );
    // Идемпотентно добавляем created_at если таблица была создана старой схемой (без неё)
    await db.execute(
      drizzleSql`ALTER TABLE cg_liq_heatmap_snapshot ADD COLUMN IF NOT EXISTS created_at timestamp DEFAULT now()`,
    );
    // Не удаляем исторические снимки: backfill нужен для анализа за пределами 30 дней.

    // cg_netflow_snapshot: снапшоты taker-netflow каждые 15 мин для 100 CoinGlass символов
    await db.execute(drizzleSql`CREATE TABLE IF NOT EXISTS cg_netflow_snapshot (
      id           serial PRIMARY KEY,
      symbol       text      NOT NULL,
      snapshot_at  timestamp NOT NULL,
      buy_1h       real, sell_1h  real, net_1h  real, net_pct_1h real,
      buy_4h       real, sell_4h  real, net_4h  real, net_pct_4h real,
      buy_24h      real, sell_24h real, net_24h real,
      market_cap_usd real,
      created_at   timestamp NOT NULL DEFAULT now(),
      UNIQUE (symbol, snapshot_at)
    )`);
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS cg_netflow_snap_symbol_idx ON cg_netflow_snapshot (symbol, snapshot_at DESC)`,
    );
    // TTL: хранить 7 дней
    await db.execute(
      drizzleSql`DELETE FROM cg_netflow_snapshot WHERE created_at < NOW() - INTERVAL '7 days'`,
    );

    // tracked_signals — liq-cascade триггерные параметры (2026-07-22)
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_liq_long1h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_liq_long24h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_liq_ratio real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_liq_reason text`,
    );

    // tracked_signals — BingX orderbook snapshot при выстреле сигнала (2026-07-22)
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_ob_bids real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_ob_asks real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_ob_ratio real`,
    );

    // tracked_signals — OI 24h, 1h цена и futures taker при выстреле (универсально для всех паттернов)
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_oi_24h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_price_1h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS entry_fut_taker_net_buy real`,
    );

    // prescan_tracker — last_price_24h column (2026-07-23)
    // Персистируем lastPrice24h чтобы после рестарта не показывать firstPrice24h (значение при первом появлении).
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS last_price_24h real`,
    );

    // prescan_tracker — taker / CVD verdict columns (2026-07-23)
    // Персистируем futures taker netBuyPct, spot taker и CVD verdicts чтобы после рестарта
    // UI prescan-таблица и гейты сканера не показывали "—" (null) до первого скана (~10мин).
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS last_net_buy_pct real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS last_spot_taker_net_buy real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS last_spot_taker_dominance text`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS last_cvd_30m boolean`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS last_cvd_1h boolean`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS last_cvd_4h boolean`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS last_vol_mult real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS has_fired_before boolean DEFAULT false`,
    );

    // overheat_log — новые аналитические колонки для ретроанализа (2026-07-23)
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS entry_vol_24h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS first_seen_at timestamp`,
    );
    // retro — legacy compatibility marker for historical overheat rows.
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS retro boolean NOT NULL DEFAULT false`,
    );

    // overheat_log — layers column type fix: text → text[] (2026-07-22)
    // Drizzle-схема определяет layers как .array(), но таблица была создана с type=text →
    // INSERT с array-значением падал с type mismatch, dbWriteBestEffort глотал ошибку → таблица пустая.
    await db.execute(drizzleSql`
      DO $$ BEGIN
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_name = 'overheat_log' AND column_name = 'layers') = 'text' THEN
          ALTER TABLE overheat_log ALTER COLUMN layers TYPE text[] USING ARRAY[]::text[];
        END IF;
      END $$
    `);

    // growth_leader_log v3 — новые колонки (retro-v2 batch, inter-cycle deltas, CG coverage flag).
    // Добавляем идемпотентно, т.к. часть таблиц уже существовала без них.
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS prev_oi_30m real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS prev_oi_4h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS spot_cvd_4h boolean`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS spot_taker_net_buy_pct real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS prev_spot_vol_mult real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS cg_oi_available boolean`,
    );

    // Обновляем порог OI с 5% → 8% для сокращения отмен по слабым сигналам
    const updated = await db
      .update(settingsTable)
      .set({ oiChangePercent: 8 })
      .where(lt(settingsTable.oiChangePercent, 8))
      .returning({ oiChangePercent: settingsTable.oiChangePercent });
    if (updated.length > 0)
      logger.info(
        { newThreshold: 8 },
        "Startup migration: oiChangePercent обновлён до 8%",
      );

    // Снапшоты цены для overheat_log — обновляются каждый скан-цикл
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS snapshot_price real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS snapshot_at timestamp`,
    );

    // Одноразовая чистка «призраков» из overheat_log: строки без prescan-данных
    // (токены, которых не было в prescanTracker в момент логирования — напр. новые листинги).
    // Идемпотентно: повторный запуск no-op (строк с такой комбинацией NULL уже нет).
    await db.execute(drizzleSql`
      DELETE FROM overheat_log
      WHERE entry_price IS NULL
        AND entry_price_24h IS NULL
        AND cycle_count IS NULL
    `);

    // prescan_history — новые колонки для полного snapshot всех scored токенов
    await db.execute(
      drizzleSql`ALTER TABLE prescan_history ADD COLUMN IF NOT EXISTS net_buy_pct real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_history ADD COLUMN IF NOT EXISTS spot_taker_net_buy real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_history ADD COLUMN IF NOT EXISTS oi_accel_30m real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_history ADD COLUMN IF NOT EXISTS fut_spot_ratio real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_history ADD COLUMN IF NOT EXISTS whale_index real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_history ADD COLUMN IF NOT EXISTS snf_1h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_history ADD COLUMN IF NOT EXISTS ob_ratio real`,
    );

    // scan_reject_log — индексы для быстрых аналитических запросов (2026-07-27)
    // Таблица накопила 114k+ строк без индекса на (pattern, cycle_at) →
    // WHERE pattern IN (...) AND cycle_at > NOW()-'14 days' завершался ROLLBACK.
    // CONCURRENTLY не блокирует INSERT во время построения (важно для live-сервера).
    await db.execute(
      drizzleSql`CREATE INDEX CONCURRENTLY IF NOT EXISTS scan_reject_log_pattern_cycle_idx ON scan_reject_log (pattern, cycle_at DESC)`,
    );
    await db.execute(
      drizzleSql`CREATE INDEX CONCURRENTLY IF NOT EXISTS scan_reject_log_cycle_desc_idx ON scan_reject_log (cycle_at DESC)`,
    );
    // Удаляем дублирующий plain-индекс (cycle_at ASC) из Part 1 — B-tree покрывает оба направления,
    // DESC-индекс выше полностью заменяет его. Идемпотентно: IF EXISTS.
    await db.execute(
      drizzleSql`DROP INDEX CONCURRENTLY IF EXISTS scan_reject_log_cycle_idx`,
    );

    // pattern_decision_snapshots: classifyUnfillable (watcher) searches unpriced
    // pending rows ordered by id. Without this partial index the planner walks the
    // whole primary key (2.39M rows, 5.7 s warm, "Query read timeout" under load).
    // The predicate matches that query exactly; the index holds only such rows.
    await db.execute(
      drizzleSql`CREATE INDEX CONCURRENTLY IF NOT EXISTS pattern_decision_snapshots_unpriced_open_idx ON pattern_decision_snapshots (id) WHERE (entry_price IS NULL OR entry_price <= 0) AND trajectory_status IN ('pending', 'partial', 'retry')`,
    );
    // Trajectory claim (2026-10-21): per-pattern oldest-first selection of open
    // trajectories. The claim query timed out on the full backlog and no
    // trajectory was claimed after 2026-10-06; this partial index serves the
    // bounded prefilter in claimPatternDecisionTrajectories.
    await db.execute(
      drizzleSql`CREATE INDEX CONCURRENTLY IF NOT EXISTS pattern_decision_snapshots_trajectory_open_idx ON pattern_decision_snapshots (pattern_key, decision_at, id) WHERE entry_price > 0 AND trajectory_status IN ('pending', 'partial', 'retry')`,
    );
    await db.execute(
      drizzleSql`CREATE INDEX CONCURRENTLY IF NOT EXISTS pattern_decision_snapshots_trajectory_open_fired_idx ON pattern_decision_snapshots (pattern_key, decision_at, id) WHERE decision_kind = 'fired' AND entry_price > 0 AND trajectory_status IN ('pending', 'partial', 'retry')`,
    );

    // growth_leader_log: SNF + Whale Index (2026-07-29)
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS snf_1h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS snf_4h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS snf_24h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS whale_index real`,
    );
    // growth_leader_log — OB ratio (бэкфилл, ~15 мин задержка после записи строки)
    await db.execute(
      drizzleSql`ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS ob_ratio real`,
    );

    // overheat_log: полный набор аналитических метрик — CVD, SNF, WI, OB, Vol (2026-07-29)
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS cvd_1h boolean`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS cvd_4h boolean`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS snf_1h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS snf_4h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS snf_24h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS whale_index real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS spot_vol_mult real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS fut_vol_mult real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS fut_vol_usd_24h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS spot_vol_usd_24h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS oi_1h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS oi_4h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS price_1h real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS spot_taker_net_buy_pct real`,
    );
    // overheat_log — OB ratio + funding rate в момент перегрева (2026-07-30)
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS ob_ratio real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS funding_rate real`,
    );
    // overheat_log — OB ratio + funding rate в момент ВХОДА в prescan (2026-07-30)
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS entry_ob_ratio real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS entry_funding_rate real`,
    );
    // prescan_tracker — OB ratio + funding rate при первом попадании в prescan (2026-07-30)
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS first_ob_ratio real`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS first_funding_rate real`,
    );
    // growth_leader_log + overheat_log — полный набор метрик (2026-07-30)
    for (const _glDdl of [
      "cvd_15m boolean",
      "oi_24h real",
      "fut_taker_net_buy real",
    ]) {
      await db.execute(
        drizzleSql.raw(
          `ALTER TABLE growth_leader_log ADD COLUMN IF NOT EXISTS ${_glDdl}`,
        ),
      );
    }
    for (const _ohDdl of [
      "cvd_15m boolean",
      "cvd_30m boolean",
      "oi_30m real",
      "oi_24h real",
      "fut_taker_net_buy real",
      "price_72h_pct real",
    ]) {
      await db.execute(
        drizzleSql.raw(
          `ALTER TABLE overheat_log ADD COLUMN IF NOT EXISTS ${_ohDdl}`,
        ),
      );
    }
    // tracked_signals — exit-снапшот полного набора метрик при закрытии (2026-07-30)
    for (const _exitDdl of [
      "exit_oi_30m real",
      "exit_oi_1h real",
      "exit_oi_4h real",
      "exit_oi_24h real",
      "exit_cvd_15m boolean",
      "exit_cvd_30m boolean",
      "exit_cvd_1h boolean",
      "exit_cvd_4h boolean",
      "exit_whale_index real",
      "exit_spot_taker_net_buy real",
      "exit_fut_taker_net_buy real",
      "exit_spot_net_buy_1h real",
      "exit_spot_vol_1h real",
      "exit_spot_vol_mult real",
      "exit_fut_vol_mult real",
      "exit_funding_rate real",
      "exit_price_1h real",
      "exit_price_24h real",
      "exit_fut_spot_ratio real",
      // Legacy split fields are retained for historical/open positions.
      "split_limit_price real",
      "split_filled_at timestamp",
      "entry_policy_version text",
      // POSITION UPDATE по смене состояния (2026-07-31)
      "last_update_state text",
      // POSITION UPDATE anti-spam state: survives restart and is claimed
      // atomically with the Telegram outbox event.
      "health_pending_state text",
      "health_pending_count integer NOT NULL DEFAULT 0",
      "health_sent_types text[] NOT NULL DEFAULT '{}'",
      "health_ordinary_sent_count integer NOT NULL DEFAULT 0",
      "health_last_ordinary_at timestamp",
      // Доставка milestone-уведомлений отделена от last_milestone: при сбое
      // Telegram fast-cycle повторит отправку, не меняя торговое состояние.
      "pending_milestone integer",
      "pending_milestone_kind text",
      "pending_milestone_price real",
      "pending_milestone_trailing_stop real",
      "pending_milestone_status text",
      "pending_milestone_lease_until timestamp",
    ]) {
      await db.execute(
        drizzleSql.raw(
          `ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS ${_exitDdl}`,
        ),
      );
    }
    // Cancellation outcome audit: a price collected after the 72h threshold is
    // not necessarily an exact 72-hour price, so persist its actual ticker time.
    await db.execute(
      drizzleSql`ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS price_72h_after_exit_observed_at timestamp`,
    );
    // Legacy pending rows have no delivery outcome. Telegram may already have
    // accepted them, so suppress them instead of reclaiming and resending.
    await db.execute(drizzleSql`
      UPDATE tracked_signals
      SET pending_milestone = NULL,
          pending_milestone_kind = NULL,
          pending_milestone_price = NULL,
          pending_milestone_trailing_stop = NULL,
          pending_milestone_status = NULL,
          pending_milestone_lease_until = NULL
      WHERE pending_milestone IS NOT NULL
        AND pending_milestone_status IS NULL
    `);
    await db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS milestone_notification_deliveries (
        id                serial PRIMARY KEY,
        tracked_signal_id integer NOT NULL,
        milestone         integer NOT NULL,
        milestone_kind    text NOT NULL,
        target            text NOT NULL,
        status            text NOT NULL DEFAULT 'ready',
        lease_until       timestamp,
        claim_token       text,
        delivered_at      timestamp,
        last_error        text,
        attempts          integer NOT NULL DEFAULT 0,
        created_at        timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS milestone_notification_delivery_unique
      ON milestone_notification_deliveries
        (tracked_signal_id, milestone_kind, milestone, target)
    `);
    await db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS milestone_notification_delivery_state_idx
      ON milestone_notification_deliveries (status, lease_until)
    `);
    await db.execute(drizzleSql`
      ALTER TABLE milestone_notification_deliveries
      ADD COLUMN IF NOT EXISTS claim_token text
    `);
    await db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS telegram_photo_deliveries (
        id              serial PRIMARY KEY,
        dedup_key       text NOT NULL,
        target          text NOT NULL,
        photo_path      text NOT NULL,
        caption         text NOT NULL,
        fallback_text   text NOT NULL,
        status          text NOT NULL DEFAULT 'ready',
        phase           text NOT NULL DEFAULT 'photo',
        next_attempt_at timestamp NOT NULL DEFAULT now(),
        lease_until     timestamp,
        claim_token     text,
        delivered_at    timestamp,
        last_error      text,
        attempts        integer NOT NULL DEFAULT 0,
        created_at      timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS telegram_photo_delivery_dedup_target_unique
      ON telegram_photo_deliveries (dedup_key, target)
    `);
    await db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS telegram_photo_delivery_due_idx
      ON telegram_photo_deliveries (status, next_attempt_at, lease_until)
    `);
    // ── missed_movers: токены покинувшие prescan без сигнала (2026-08-14) ────────
    await db.execute(drizzleSql`CREATE TABLE IF NOT EXISTS missed_movers (
      id              serial    PRIMARY KEY,
      symbol          text      NOT NULL,
      exited_at       timestamp NOT NULL DEFAULT now(),
      first_seen_at   real,
      cycles_in_pool  integer,
      exit_reason     text,
      p24h_at_exit    real,
      p1h_at_exit     real,
      price_at_exit   real,
      oi30m_at_exit   real,
      oi1h_at_exit    real,
      oi4h_at_exit    real,
      vol_mult_at_exit real,
      spot_vol_usd_24h real,
      fut_spot_ratio  real,
      whale_index     real,
      snf_1h          real,
      funding_rate    real,
       ob_ratio_at_exit real,
      cvd_30m         boolean,
      cvd_1h          boolean,
      cvd_4h          boolean,
      reject_reasons  jsonb,
      price_24h_after real,
      price_72h_after real,
      peak_pct_after_24h real
    )`);
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS missed_movers_exited_at_idx ON missed_movers (exited_at DESC)`,
    );
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS missed_movers_symbol_idx ON missed_movers (symbol)`,
    );
    // Unique constraint — idempotency key for ON CONFLICT DO NOTHING on retry/timeout
    await db.execute(
      drizzleSql`CREATE UNIQUE INDEX IF NOT EXISTS missed_movers_sym_exited_uniq ON missed_movers (symbol, exited_at)`,
    );
    // TTL: хранить 90 дней — таблица для калибровки, данные нужны надолго
    await db.execute(
      drizzleSql`DELETE FROM missed_movers WHERE exited_at < NOW() - INTERVAL '90 days'`,
    );

    // ── missed_movers_prices: hourly intraday price samples during the 24h window ──
    // One row per (missed_mover_id, sampled_at truncated to hour).
    // peakPctAfter24h is computed as MAX(price) / priceAtExit across all samples.
    await db.execute(drizzleSql`CREATE TABLE IF NOT EXISTS missed_movers_prices (
      id              serial    PRIMARY KEY,
      missed_mover_id integer   NOT NULL REFERENCES missed_movers(id) ON DELETE CASCADE,
      sampled_at      timestamp NOT NULL,
      price           real      NOT NULL,
      UNIQUE (missed_mover_id, sampled_at)
    )`);
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS mmp_mover_id_idx ON missed_movers_prices (missed_mover_id)`,
    );
    // TTL: samples older than 30 days are no longer needed for calibration
    await db.execute(
      drizzleSql`DELETE FROM missed_movers_prices WHERE sampled_at < NOW() - INTERVAL '30 days'`,
    );

    // ── missed_mover_prescan_snapshots: durable trajectory per missed mover ───
    // Values are copied from rolling prescan_snapshots, but source_snapshot_id is
    // deliberately not a foreign key. The rolling source table has a short TTL;
    // this child must survive for the same 90-day lifetime as its parent mover.
    await db.execute(
      drizzleSql`CREATE TABLE IF NOT EXISTS missed_mover_prescan_snapshots (
        id                 serial    PRIMARY KEY,
        missed_mover_id    integer   NOT NULL REFERENCES missed_movers(id) ON DELETE CASCADE,
        source_snapshot_id integer   NOT NULL,
        is_exit_snapshot   boolean   NOT NULL DEFAULT false,
        cycle_at           timestamp NOT NULL,
        p24h               real,
        p1h                real,
        price              real,
        oi30m              real,
         oi1h               real,
        oi4h               real,
        vol_mult           real,
         spot_vol_usd_24h   real,
         fut_spot_ratio     real,
        whale_index        real,
         snf_1h             real,
         funding_rate       real,
         ob_ratio           real,
        cvd_30m            boolean,
         cvd_1h             boolean,
        cvd_4h             boolean,
        cycles_in_pool     integer,
        UNIQUE (missed_mover_id, source_snapshot_id)
      )`,
    );
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS mmps_mover_cycle_idx ON missed_mover_prescan_snapshots (missed_mover_id, cycle_at)`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE missed_mover_prescan_snapshots ADD COLUMN IF NOT EXISTS is_exit_snapshot boolean NOT NULL DEFAULT false`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE missed_mover_prescan_snapshots
        ADD COLUMN IF NOT EXISTS oi1h real,
        ADD COLUMN IF NOT EXISTS spot_vol_usd_24h real,
        ADD COLUMN IF NOT EXISTS fut_spot_ratio real,
        ADD COLUMN IF NOT EXISTS snf_1h real,
        ADD COLUMN IF NOT EXISTS funding_rate real,
        ADD COLUMN IF NOT EXISTS ob_ratio real,
        ADD COLUMN IF NOT EXISTS cvd_1h boolean`,
    );
    await db.execute(
      drizzleSql`ALTER TABLE missed_movers ADD COLUMN IF NOT EXISTS ob_ratio_at_exit real`,
    );
    await db.execute(drizzleSql`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'missed_mover_prescan_snapshots' AND column_name = 'cvd30m'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'missed_mover_prescan_snapshots' AND column_name = 'cvd_30m'
        ) THEN
          ALTER TABLE missed_mover_prescan_snapshots RENAME COLUMN cvd30m TO cvd_30m;
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'missed_mover_prescan_snapshots' AND column_name = 'cvd4h'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'missed_mover_prescan_snapshots' AND column_name = 'cvd_4h'
        ) THEN
          ALTER TABLE missed_mover_prescan_snapshots RENAME COLUMN cvd4h TO cvd_4h;
        END IF;
      END $$
    `);

    // ── prescan_snapshots: per-cycle metric trajectory for all prescan tokens ──
    // One row per token per scan cycle. 14-day rolling TTL, matching the
    // missed-mover trajectory backfill recovery window.
    await db.execute(drizzleSql`CREATE TABLE IF NOT EXISTS prescan_snapshots (
      id             serial    PRIMARY KEY,
      symbol         text      NOT NULL,
      cycle_at       timestamp NOT NULL,
      p24h           real,
      p1h            real,
      price          real,
      oi30m          real,
       oi1h           real,
      oi4h           real,
      vol_mult       real,
       spot_vol_usd_24h real,
       fut_spot_ratio real,
      whale_index    real,
       snf_1h         real,
       funding_rate   real,
       ob_ratio       real,
      cvd_30m        boolean,
       cvd_1h         boolean,
      cvd_4h         boolean,
      cycles_in_pool integer
    )`);
    await db.execute(
      drizzleSql`ALTER TABLE prescan_snapshots
        ADD COLUMN IF NOT EXISTS oi1h real,
        ADD COLUMN IF NOT EXISTS spot_vol_usd_24h real,
        ADD COLUMN IF NOT EXISTS fut_spot_ratio real,
        ADD COLUMN IF NOT EXISTS snf_1h real,
        ADD COLUMN IF NOT EXISTS funding_rate real,
        ADD COLUMN IF NOT EXISTS ob_ratio real,
        ADD COLUMN IF NOT EXISTS cvd_1h boolean`,
    );
    await db.execute(drizzleSql`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'prescan_snapshots' AND column_name = 'cvd30m'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'prescan_snapshots' AND column_name = 'cvd_30m'
        ) THEN
          ALTER TABLE prescan_snapshots RENAME COLUMN cvd30m TO cvd_30m;
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'prescan_snapshots' AND column_name = 'cvd4h'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'prescan_snapshots' AND column_name = 'cvd_4h'
        ) THEN
          ALTER TABLE prescan_snapshots RENAME COLUMN cvd4h TO cvd_4h;
        END IF;
      END $$
    `);
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS pss_symbol_cycle_idx ON prescan_snapshots (symbol, cycle_at)`,
    );
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS pss_cycle_at_idx ON prescan_snapshots (cycle_at)`,
    );
    await db.execute(
      drizzleSql`DELETE FROM prescan_snapshots WHERE cycle_at < NOW() - INTERVAL '14 days'`,
    );

    // Stop fields are immutable for open rows. New rows receive their
    // pattern-specific policy at insertion time; never rewrite legacy rows on
    // restart (including pending split fills).

    // ── Broadcast window dedup (2026-08-21) ─────────────────────────────────────
    // broadcast_window_key = "symbol:30min_bucket" — уникальный ключ который не даёт
    // создать второй сигнал для той же монеты в том же 30-мин окне через ON CONFLICT DO NOTHING.
    // Исправляет системную проблему дублей: два code-path (scanner + watcher Path A/B)
    // могли создавать разные signal.id для одной монеты → два разных outbox dedup-key → два Telegram.
    await db.execute(
      drizzleSql`ALTER TABLE signals ADD COLUMN IF NOT EXISTS broadcast_window_key text`,
    );
    await db.execute(
      drizzleSql`CREATE UNIQUE INDEX IF NOT EXISTS signals_broadcast_window_key_unique ON signals (broadcast_window_key) WHERE broadcast_window_key IS NOT NULL`,
    );
  } catch (err) {
    logger.warn(
      { err },
      "Startup migration Part 2 (accum tables): ошибка (non-critical)",
    );
  }

  // ── Part 2b: signal_trajectory_log ──────────────────────────────────────────
  try {
    await db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS signal_trajectory_log (
        id             serial PRIMARY KEY,
        signal_id      integer NOT NULL,
        symbol         text NOT NULL,
        sentiment_key  text NOT NULL,
        interval_label text NOT NULL,
        snapshot_at    timestamp NOT NULL DEFAULT now(),
        elapsed_ms     bigint NOT NULL,
        price_at       real NOT NULL,
        pct_from_entry real NOT NULL,
        peak_pct       real NOT NULL,
        status         text NOT NULL
      )
    `);
    await db.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS signal_trajectory_log_signal_interval_unique
        ON signal_trajectory_log (signal_id, interval_label)
    `);
  } catch (err) {
    logger.warn(
      { err },
      "Startup migration Part 2b (signal_trajectory_log): ошибка (non-critical)",
    );
  }

  // ── Part 2b.0: stealth_hourly_snapshots (observation only) ─────────────────
  try {
    await db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS stealth_hourly_snapshots (
        id                serial PRIMARY KEY,
        tracked_signal_id integer NOT NULL,
        symbol            text NOT NULL,
        hour_index        integer NOT NULL,
        snapshot_at       timestamp NOT NULL DEFAULT now(),
        elapsed_ms        bigint NOT NULL,
        price_at          real NOT NULL,
        pct_from_entry    real NOT NULL,
        peak_pct          real NOT NULL,
        status            text NOT NULL,
        metrics           jsonb NOT NULL
      )
    `);
    await db.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS stealth_hourly_snapshots_signal_hour_unique
        ON stealth_hourly_snapshots (tracked_signal_id, hour_index)
    `);
  } catch (err) {
    logger.warn(
      { err },
      "Startup migration Part 2b.0 (stealth_hourly_snapshots): ошибка (non-critical)",
    );
  }

  // ── Part 2b.1: signal_drawdown_extrema ───────────────────────────────────────
  // Mutable one-row-per-signal summary of the lowest FastCycle PnL observed.
  // Kept separate from signal_trajectory_log so immutable interval snapshots
  // and close snapshots are never updated in place.
  try {
    await db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS signal_drawdown_extrema (
        id                 serial PRIMARY KEY,
        signal_id          integer NOT NULL,
        symbol             text NOT NULL,
        sentiment_key      text NOT NULL,
        min_pct_from_entry real NOT NULL,
        price_at_min       real NOT NULL,
        min_observed_at    timestamptz NOT NULL,
        min_elapsed_ms     bigint NOT NULL,
        source             text NOT NULL,
        status_at_min      text NOT NULL,
        updated_at         timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS signal_drawdown_extrema_signal_uniq
        ON signal_drawdown_extrema (signal_id)
    `);
    await db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_drawdown_extrema_observed_at_idx
        ON signal_drawdown_extrema (min_observed_at)
    `);
    await db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_drawdown_extrema_pattern_idx
        ON signal_drawdown_extrema (sentiment_key)
    `);
  } catch (err) {
    logger.warn(
      { err },
      "Startup migration Part 2b.1 (signal_drawdown_extrema): ошибка (non-critical)",
    );
  }

  // ── Part 2b.2: trailing analytics (actual + shadow) ─────────────────────────
  // Purely observational tables: they are never read by the live exit path.
  try {
    await db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS signal_trailing_events (
        id                       serial PRIMARY KEY,
        signal_id                integer NOT NULL,
        symbol                   text NOT NULL,
        sentiment_key            text NOT NULL,
        event_type               text NOT NULL,
        is_short                 boolean NOT NULL DEFAULT false,
        activation_pct           real NOT NULL,
        trailing_gap_pct         real NOT NULL,
        observed_at              timestamptz NOT NULL,
        peak_price               real NOT NULL,
        peak_pnl_pct             real NOT NULL,
        current_price            real NOT NULL,
        current_pnl_pct          real NOT NULL,
        trailing_stop_price      real NOT NULL,
        theoretical_exit_pnl_pct real NOT NULL,
        actual_status            text,
        actual_exit_price        real,
        actual_pnl_pct           real,
        closed_at                timestamptz,
        latency_ms               bigint,
        price_source             text NOT NULL DEFAULT 'fast_cycle'
      )
    `);
    await db.execute(drizzleSql`
      ALTER TABLE signal_trailing_events
        ADD COLUMN IF NOT EXISTS price_source text NOT NULL DEFAULT 'fast_cycle'
    `);
    await db.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS signal_trailing_events_signal_type_uniq
        ON signal_trailing_events (signal_id, event_type)
    `);
    await db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_trailing_events_pattern_idx
        ON signal_trailing_events (sentiment_key)
    `);
    await db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_trailing_events_observed_at_idx
        ON signal_trailing_events (observed_at)
    `);

    await db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS signal_trailing_shadow_events (
        id                  serial PRIMARY KEY,
        signal_id           integer NOT NULL,
        symbol              text NOT NULL,
        sentiment_key       text NOT NULL,
        is_short            boolean NOT NULL DEFAULT false,
        activation_pct      real NOT NULL,
        trailing_gap_pct    real NOT NULL,
        event_type          text NOT NULL,
        observed_at         timestamptz NOT NULL,
        current_price       real NOT NULL,
        current_pnl_pct     real NOT NULL,
        peak_price          real NOT NULL,
        peak_pnl_pct        real NOT NULL,
        virtual_stop_price  real NOT NULL,
        actual_status       text,
        actual_exit_price   real,
        actual_pnl_pct      real
      )
    `);
    await db.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS signal_trailing_shadow_event_uniq
        ON signal_trailing_shadow_events
        (signal_id, activation_pct, trailing_gap_pct, event_type)
    `);
    await db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_trailing_shadow_pattern_idx
        ON signal_trailing_shadow_events (sentiment_key)
    `);
    await db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_trailing_shadow_event_at_idx
        ON signal_trailing_shadow_events (observed_at)
    `);
  } catch (err) {
    logger.warn(
      { err },
      "Startup migration Part 2b.2 (trailing analytics): ошибка (non-critical)",
    );
  }

  // ── Part 2b.3: entry-anchored +10% → +5% profit-lock shadow ───────────────
  // Observational only. The watcher never reads this table to change a live
  // stop, target, or trailing decision.
  try {
    await db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS signal_profit_lock_shadow_events (
        id                serial PRIMARY KEY,
        signal_id         integer NOT NULL,
        symbol            text NOT NULL,
        sentiment_key     text NOT NULL,
        is_short          boolean NOT NULL DEFAULT false,
        activation_pct    real NOT NULL,
        locked_profit_pct real NOT NULL,
        event_type        text NOT NULL,
        observed_at       timestamptz NOT NULL,
        current_price     real NOT NULL,
        current_pnl_pct   real NOT NULL,
        peak_price        real NOT NULL,
        peak_pnl_pct      real NOT NULL,
        locked_stop_price real NOT NULL,
        actual_status     text,
        actual_exit_price real,
        actual_pnl_pct    real
      )
    `);
    await db.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS signal_profit_lock_shadow_event_uniq
        ON signal_profit_lock_shadow_events
        (signal_id, activation_pct, locked_profit_pct, event_type)
    `);
    await db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_profit_lock_shadow_pattern_idx
        ON signal_profit_lock_shadow_events (sentiment_key)
    `);
    await db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_profit_lock_shadow_event_at_idx
        ON signal_profit_lock_shadow_events (observed_at)
    `);
    await db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_profit_lock_shadow_type_at_idx
        ON signal_profit_lock_shadow_events (event_type, observed_at)
    `);
    // A virtual hit is always evaluated at its protected +5% level. This
    // normalization repairs any early rows recorded at a later sampled price.
    await db.execute(drizzleSql`
      UPDATE signal_profit_lock_shadow_events
      SET current_price = locked_stop_price,
          current_pnl_pct = locked_profit_pct
      WHERE event_type = 'hit'
        AND (
          current_price IS DISTINCT FROM locked_stop_price
          OR current_pnl_pct IS DISTINCT FROM locked_profit_pct
        )
    `);
  } catch (err) {
    logger.warn(
      { err },
      "Startup migration Part 2b.3 (profit-lock shadow): ошибка (non-critical)",
    );
  }

  // ── Part 2c: signal_health_events ────────────────────────────────────────────
  try {
    await db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS signal_health_events (
        id              serial PRIMARY KEY,
        signal_id       integer NOT NULL,
        symbol          text NOT NULL,
        sentiment_key   text NOT NULL,
        message_type    text NOT NULL,
        pnl_at_send     real,
        oi_30m          real,
        turnover        real,
        cvd_15m         boolean,
        cvd_30m         boolean,
        cvd_1h          boolean,
        price_at_send   real,
        entry_price     real,
        sent_at         timestamp NOT NULL DEFAULT now(),
        observed_4h_at  timestamp,
        observed_8h_at  timestamp,
        observed_24h_at timestamp,
        price_4h_pct    real,
        price_8h_pct    real,
        price_24h_pct   real
      )
    `);
    await db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_health_events_signal_idx
        ON signal_health_events (signal_id)
    `);
    await db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_health_events_sent_at_idx
        ON signal_health_events (sent_at DESC)
    `);
  } catch (err) {
    logger.warn(
      { err },
      "Startup migration Part 2c (signal_health_events): ошибка (non-critical)",
    );
  }

  // ── Part 2d: signal_cancel_outcomes ──────────────────────────────────────────
  try {
    await db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS signal_cancel_outcomes (
        id              serial PRIMARY KEY,
        signal_id       integer NOT NULL,
        symbol          text NOT NULL,
        sentiment_key   text NOT NULL,
        cancel_reason   text NOT NULL,
        pnl_at_cancel   real,
        price_at_cancel real,
        entry_price     real,
        sent_at         timestamp NOT NULL DEFAULT now(),
        observed_4h_at  timestamp,
        observed_8h_at  timestamp,
        observed_24h_at timestamp,
        price_4h_pct    real,
        price_8h_pct    real,
        price_24h_pct   real
      )
    `);
    await db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_cancel_outcomes_signal_idx
        ON signal_cancel_outcomes (signal_id)
    `);
    await db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signal_cancel_outcomes_sent_at_idx
        ON signal_cancel_outcomes (sent_at DESC)
    `);
  } catch (err) {
    logger.warn(
      { err },
      "Startup migration Part 2d (signal_cancel_outcomes): ошибка (non-critical)",
    );
  }

  // ── Part 2e: cancel_outcome_weekly_snapshots ─────────────────────────────────
  try {
    await db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS cancel_outcome_weekly_snapshots (
        id                serial PRIMARY KEY,
        snapshot_week     date NOT NULL,
        cancel_reason     text NOT NULL,
        total             integer NOT NULL DEFAULT 0,
        observed          integer NOT NULL DEFAULT 0,
        false_cancels     integer NOT NULL DEFAULT 0,
        false_cancel_rate real,
        avg_pnl           real,
        avg_p24h          real,
        created_at        timestamp NOT NULL DEFAULT now(),
        UNIQUE (snapshot_week, cancel_reason)
      )
    `);
    await db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS cancel_outcome_weekly_snapshots_week_idx
        ON cancel_outcome_weekly_snapshots (snapshot_week DESC)
    `);
  } catch (err) {
    logger.warn(
      { err },
      "Startup migration Part 2e (cancel_outcome_weekly_snapshots): ошибка (non-critical)",
    );
  }

  // ── Part 3: inflow_outflow_l14_pool + candidate_growth_tracking ──
  try {
    await db.execute(drizzleSql`CREATE TABLE IF NOT EXISTS inflow_outflow_l14_pool (
      id                     serial PRIMARY KEY,
      symbol                 text NOT NULL,
      coin_symbol            text NOT NULL,
      status                 text NOT NULL DEFAULT 'watching',
      detected_at            timestamp NOT NULL DEFAULT now(),
      expires_at             timestamp NOT NULL,
      entry_price            real,
      tx_count               integer DEFAULT 0,
      total_outflow_usd      double precision,
      exchange_name          text,
      transfer_type          text DEFAULT 'outflow',
      balance_change_7d_pct  real,
      matched_pattern        text
    )`);
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS inflow_outflow_l14_symbol_status_idx ON inflow_outflow_l14_pool (symbol, status)`,
    );
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS inflow_outflow_l14_detected_at_idx  ON inflow_outflow_l14_pool (detected_at)`,
    );

    await db.execute(drizzleSql`CREATE TABLE IF NOT EXISTS candidate_growth_tracking (
      id                   serial PRIMARY KEY,
      symbol               text NOT NULL,
      detection_source     text NOT NULL,
      entry_price          real,
      entry_timestamp      timestamp NOT NULL DEFAULT now(),
      growth_from_entry_pct real,
      matched_pattern      text,
      status               text NOT NULL DEFAULT 'watching',
      source_table_id      integer,
      updated_at           timestamp NOT NULL DEFAULT now()
    )`);
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS candidate_growth_tracking_symbol_source_idx ON candidate_growth_tracking (symbol, detection_source)`,
    );
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS candidate_growth_tracking_status_idx       ON candidate_growth_tracking (status)`,
    );
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS candidate_growth_tracking_entry_ts_idx     ON candidate_growth_tracking (entry_timestamp)`,
    );
    await db.execute(
      drizzleSql`CREATE UNIQUE INDEX IF NOT EXISTS candidate_growth_tracking_symbol_source_uq ON candidate_growth_tracking (symbol, detection_source) WHERE status = 'watching'`,
    );
    // TTL: чистим старые записи (60 дней)
    await db.execute(
      drizzleSql`DELETE FROM inflow_outflow_l14_pool     WHERE detected_at     < NOW() - INTERVAL '60 days'`,
    );
    await db.execute(
      drizzleSql`DELETE FROM candidate_growth_tracking   WHERE entry_timestamp < NOW() - INTERVAL '60 days'`,
    );
  } catch (err) {
    logger.warn({ err }, "Startup migration Part 3: ошибка (non-critical)");
  }

  // ── Part 4: Restore ошибочно закрытых liquidation_cascade сигналов ────────
  // 2026-07-21: liquidation_cascade был ошибочно добавлен в DEAD_PATTERN_KEYS,
  // из-за чего сигналы WLD/ONDO/BEAT закрылись без уведомления при рестарте.
  // Восстанавливаем все liq_cascade сигналы с cancel_reason='dead_pattern'.
  // Идемпотентно: после первого деплоя таких строк больше нет.
  try {
    const restored = await db
      .update(trackedSignalsTable)
      .set({
        status: "active",
        cancelReason: null,
        exitPrice: null,
        pnlPercent: null,
        closedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(trackedSignalsTable.sentimentKey, "liquidation_cascade"),
          eq(trackedSignalsTable.status, "cancelled"),
          eq(trackedSignalsTable.cancelReason, "dead_pattern"),
        ),
      )
      .returning({
        id: trackedSignalsTable.id,
        symbol: trackedSignalsTable.symbol,
      });
    if (restored.length > 0) {
      logger.info(
        {
          count: restored.length,
          symbols: restored.map((r) => r.symbol).join(", "),
        },
        "🔧 Восстановлены ошибочно закрытые liquidation_cascade сигналы",
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      "Startup Part 4 (liq_cascade restore): ошибка (non-critical)",
    );
  }

  // ── Part 5: compatibility schema for retired overheat analytics ────────────
  try {
    await db.execute(drizzleSql`CREATE TABLE IF NOT EXISTS overheat_log (
      id              serial PRIMARY KEY,
      symbol          text NOT NULL,
      kicked_at       timestamp NOT NULL DEFAULT now(),
      price_24h       real NOT NULL,
      price           real,
      entry_price     real,
      entry_price_24h real,
      entry_oi_30m    real,
      entry_oi_1h     real,
      entry_oi_4h     real,
      cycle_count     integer,
      layers          text[],
      matched_pattern text
    )`);
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS overheat_log_kicked_at_idx ON overheat_log (kicked_at)`,
    );
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS overheat_log_symbol_idx ON overheat_log (symbol)`,
    );
    // The table remains for compatibility with existing environments; no live
    // writer or backfill repopulates it.
  } catch (err) {
    logger.warn(
      { err },
      "Startup migration Part 5 (overheat_log): ошибка (non-critical)",
    );
  }

  // ── Part 6: Backfill market_cap_usd для сигналов с NULL (идемпотентно) ──────
  // tracked_signals.market_cap_usd = NULL для старых сигналов (поле добавлено позже создания).
  // market_cap_cache хранит mcap за 7 дней (base-символ без -USDT, напр. "BTC").
  // JOIN: ts.symbol = mcc.symbol || '-USDT'. Идемпотентно: WHERE market_cap_usd IS NULL.
  try {
    const mcapResult = await db.execute(drizzleSql`
      UPDATE tracked_signals ts
      SET market_cap_usd = mcc.mcap_usd
      FROM market_cap_cache mcc
      WHERE ts.market_cap_usd IS NULL
        AND ts.symbol = mcc.symbol || '-USDT'
    `);
    const updated = (mcapResult as any).rowCount ?? 0;
    if (updated > 0)
      logger.info(
        { updated },
        "Startup Part 6: backfilled market_cap_usd для старых сигналов",
      );
  } catch (err) {
    logger.warn(
      { err },
      "Startup Part 6 (mcap backfill): ошибка (non-critical)",
    );
  }

  // ── Part 7: purge retired Missed Movers and overheat analytics ─────────────
  // The feature is intentionally retired. Deleting in dependency order is
  // idempotent and keeps the compatibility schema empty without touching real
  // signals, their outcomes, or signal trajectory snapshots.
  try {
    const purged = await db.transaction(async (tx) => {
      const priceSamples = await tx.execute(
        drizzleSql`DELETE FROM missed_movers_prices`,
      );
      const trajectories = await tx.execute(
        drizzleSql`DELETE FROM missed_mover_prescan_snapshots`,
      );
      const movers = await tx.execute(drizzleSql`DELETE FROM missed_movers`);
      const overheat = await tx.execute(drizzleSql`DELETE FROM overheat_log`);
      return {
        priceSamples: Number((priceSamples as any).rowCount ?? 0),
        trajectories: Number((trajectories as any).rowCount ?? 0),
        movers: Number((movers as any).rowCount ?? 0),
        overheat: Number((overheat as any).rowCount ?? 0),
      };
    });
    if (Object.values(purged).some((count) => count > 0)) {
      logger.info(
        purged,
        "Startup Part 7: retired Missed Movers and overheat analytics purged",
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      "Startup Part 7 (retired analytics purge): ошибка (non-critical)",
    );
  }

  // ── Part 8: Бэкфилл whale_index/snf_1h/ob_ratio в prescan_history ──────────
  // Одноразовый идемпотентный UPDATE для строк, созданных до Task 172 (колонки
  // были NULL). Использует prescan_tracker.first_whale_index / first_snf_1h /
  // first_ob_ratio как приближение значений на момент попадания в prescan.
  // Идемпотентно: WHERE whale_index IS NULL — повторный рестарт не трогает
  // уже заполненные строки.
  try {
    const phBackfillResult = await db.execute(drizzleSql`
      UPDATE prescan_history ph
      SET
        whale_index = pt.first_whale_index,
        snf_1h      = pt.first_snf_1h,
        ob_ratio    = pt.first_ob_ratio
      FROM prescan_tracker pt
      WHERE ph.symbol      = pt.symbol
        AND ph.whale_index IS NULL
        AND (
          pt.first_whale_index IS NOT NULL
          OR pt.first_snf_1h   IS NOT NULL
          OR pt.first_ob_ratio IS NOT NULL
        )
    `);
    const phUpdated = (phBackfillResult as any).rowCount ?? 0;
    if (phUpdated > 0) {
      logger.info(
        { updated: phUpdated },
        "Startup Part 8: бэкфилл prescan_history whale_index/snf_1h/ob_ratio завершён",
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      "Startup Part 8 (prescan_history backfill): ошибка (non-critical)",
    );
  }

  // ── Part 9: dashboard_users — таблица доступа к дашборду ──────────────────
  try {
    await db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS dashboard_users (
        id            SERIAL PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
        approved_at   TIMESTAMP,
        last_login_at TIMESTAMP,
        last_activity_at TIMESTAMP
      )
    `);
  } catch (err) {
    logger.warn(
      { err },
      "Startup Part 9 (dashboard_users): ошибка (non-critical)",
    );
  }

  // ── Part 9b: trade calculator snapshots ──────────────────────────────────
  // The calculator schema is also managed here because production may not run
  // an interactive Drizzle push during deploy. Closed monthly rows are
  // immutable; period_closed_at is NULL only for the current rolling month.
  try {
    await db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS trade_calculator_settings (
        user_id              INTEGER PRIMARY KEY REFERENCES dashboard_users(id) ON DELETE CASCADE,
        deposit_usdt         REAL NOT NULL DEFAULT 1000,
        leverage             REAL NOT NULL DEFAULT 10,
        allocation_percent   REAL NOT NULL DEFAULT 10,
        commission_percent   REAL NOT NULL DEFAULT 0.1,
        reinvest              BOOLEAN NOT NULL DEFAULT false,
        created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS trade_calculator_monthly (
        id                  SERIAL PRIMARY KEY,
        user_id             INTEGER NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
        month               TEXT NOT NULL,
        deposit_usdt         REAL NOT NULL,
        leverage             REAL NOT NULL,
        allocation_percent   REAL NOT NULL,
        commission_percent   REAL NOT NULL,
        reinvest             BOOLEAN NOT NULL DEFAULT false,
        gross_pnl_usdt       REAL NOT NULL DEFAULT 0,
        net_pnl_usdt         REAL NOT NULL DEFAULT 0,
        closed_trades        INTEGER NOT NULL DEFAULT 0,
        profit_trades        INTEGER NOT NULL DEFAULT 0,
        loss_trades           INTEGER NOT NULL DEFAULT 0,
        bu_stop_trades        INTEGER NOT NULL DEFAULT 0,
        breakeven_trades      INTEGER NOT NULL DEFAULT 0,
        expired_trades        INTEGER NOT NULL DEFAULT 0,
        cancelled_signals    INTEGER NOT NULL DEFAULT 0,
        period_closed_at     TIMESTAMP,
        calculated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(drizzleSql`
      ALTER TABLE trade_calculator_monthly
      ADD COLUMN IF NOT EXISTS period_closed_at TIMESTAMP
    `);
    await db.execute(drizzleSql`
      ALTER TABLE trade_calculator_monthly
      ADD COLUMN IF NOT EXISTS expired_trades INTEGER NOT NULL DEFAULT 0
    `);
    await db.execute(drizzleSql`
      ALTER TABLE trade_calculator_monthly
      ADD COLUMN IF NOT EXISTS bu_stop_trades INTEGER NOT NULL DEFAULT 0
    `);
    await db.execute(drizzleSql`
      ALTER TABLE trade_calculator_monthly
      DROP CONSTRAINT IF EXISTS trade_calculator_monthly_counts_check
    `);
    await db.execute(drizzleSql`
      ALTER TABLE trade_calculator_monthly
      ADD CONSTRAINT trade_calculator_monthly_counts_check CHECK (
        closed_trades >= 0
        AND profit_trades >= 0
        AND loss_trades >= 0
        AND bu_stop_trades >= 0
        AND breakeven_trades >= 0
        AND expired_trades >= 0
        AND cancelled_signals >= 0
        AND closed_trades = profit_trades + loss_trades + bu_stop_trades + breakeven_trades + expired_trades
      )
    `);
    await db.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS trade_calculator_monthly_user_month_unique
      ON trade_calculator_monthly (user_id, month)
    `);
  } catch (err) {
    logger.warn(
      { err },
      "Startup Part 9b (trade calculator): ошибка (non-critical)",
    );
  }

  // ── Part 9a: новые колонки dashboard_users и subscribers ─────────────────
  // Каждый ALTER в отдельном try/catch — чтобы сбой одного не блокировал остальные.
  for (const [label, stmt] of [
    [
      "dashboard_users.chat_id",
      drizzleSql`ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS chat_id TEXT`,
    ],
    [
      "dashboard_users.chat_id UNIQUE INDEX",
      drizzleSql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE tablename = 'dashboard_users' AND indexname = 'dashboard_users_chat_id_unique'
          ) THEN
            CREATE UNIQUE INDEX dashboard_users_chat_id_unique ON dashboard_users (chat_id) WHERE chat_id IS NOT NULL;
          END IF;
        END $$;
      `,
    ],
    [
      "dashboard_users.telegram_username",
      drizzleSql`ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS telegram_username TEXT`,
    ],
    [
      "dashboard_users.subscribed_until",
      drizzleSql`ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS subscribed_until TIMESTAMP`,
    ],
    [
      "dashboard_users.last_activity_at",
      drizzleSql`ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP`,
    ],
    [
      "subscribers.subscribed_until",
      drizzleSql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS subscribed_until TIMESTAMP`,
    ],
    [
      "subscribers.bot_blocked_at",
      drizzleSql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS bot_blocked_at TIMESTAMP`,
    ],
    [
      "subscribers.bot_blocked_reason",
      drizzleSql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS bot_blocked_reason TEXT`,
    ],
    [
      "subscribers.bot_blocked_backfill",
      drizzleSql`
        WITH blocked_events AS (
          SELECT
            target,
            observed_at AS blocked_at,
            reason
          FROM telegram_delivery_attempt_audit
          WHERE http_status = 403
            AND lower(COALESCE(reason, '')) LIKE '%blocked by the user%'

          UNION ALL

          SELECT
            target,
            COALESCE(updated_at, created_at) AS blocked_at,
            last_error AS reason
          FROM telegram_photo_deliveries
          WHERE status = 'abandoned'
            AND lower(COALESCE(last_error, '')) LIKE '%403%'
            AND lower(COALESCE(last_error, '')) LIKE '%blocked by the user%'
        ),
        latest_block AS (
          SELECT DISTINCT ON (target)
            target,
            blocked_at,
            reason
          FROM blocked_events
          ORDER BY target, blocked_at DESC
        )
        INSERT INTO subscribers (
          chat_id,
          active,
          subscribed_at,
          unsubscribed_at,
          bot_blocked_at,
          bot_blocked_reason
        )
        SELECT
          latest_block.target::bigint,
          false,
          latest_block.blocked_at,
          latest_block.blocked_at,
          latest_block.blocked_at,
          latest_block.reason
        FROM latest_block
        WHERE latest_block.target ~ '^-?[0-9]+$'
        ON CONFLICT (chat_id) DO UPDATE
        SET
          active = false,
          unsubscribed_at = COALESCE(
            subscribers.unsubscribed_at,
            EXCLUDED.unsubscribed_at
          ),
          bot_blocked_at = COALESCE(
            subscribers.bot_blocked_at,
            EXCLUDED.bot_blocked_at
          ),
          bot_blocked_reason = COALESCE(
            subscribers.bot_blocked_reason,
            EXCLUDED.bot_blocked_reason
          )
      `,
    ],
    [
      "dashboard_users.bot_blocked_access_backfill",
      drizzleSql`
        UPDATE dashboard_users AS dashboard_user
        SET
          status = 'blocked',
          last_activity_at = NULL
        FROM subscribers AS subscriber
        WHERE dashboard_user.chat_id = subscriber.chat_id::text
          AND subscriber.bot_blocked_at IS NOT NULL
          AND dashboard_user.status <> 'blocked'
      `,
    ],
  ] as const) {
    try {
      await db.execute(stmt);
    } catch (err) {
      logger.warn({ err }, `Startup Part 9a (${label}): ошибка (non-critical)`);
    }
  }

  // ── Part 9b: авто-создание owner-аккаунта если OWNER_EMAIL задан и нет записи ─
  try {
    const ownerEmail = (process.env["OWNER_EMAIL"] ?? "").toLowerCase().trim();
    if (ownerEmail) {
      // bcrypt hash of "AltBullet2026!" — начальный пароль owner-аккаунта
      const DEFAULT_HASH =
        "$2b$10$PY5zY.XVWXfDudGxZo8OIejT1qIddEpkIjmsMsjLslOPRQpTiY51m";
      await db.execute(drizzleSql`
        INSERT INTO dashboard_users (email, password_hash, name, status, approved_at)
        VALUES (${ownerEmail}, ${DEFAULT_HASH}, 'Owner', 'approved', NOW())
        ON CONFLICT (email) DO NOTHING
      `);
      logger.info(
        { ownerEmail },
        "Startup Part 9b: owner seed (ON CONFLICT DO NOTHING)",
      );
    }
  } catch (err) {
    logger.warn({ err }, "Startup Part 9b (owner seed): ошибка (non-critical)");
  }

  // ── Part 9c: dashboard_password_resets — коды сброса пароля через Telegram ──
  try {
    await db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS dashboard_password_resets (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL,
        code       TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL,
        used       BOOLEAN NOT NULL DEFAULT FALSE
      )
    `);
  } catch (err) {
    logger.warn(
      { err },
      "Startup Part 9c (dashboard_password_resets): ошибка (non-critical)",
    );
  }

  // ── Seed known subscribers (идемпотентно через ON CONFLICT) ──────────────
  try {
    const knownSubs = [
      { chatId: 7818695412, username: "darshakl", firstName: "Darya" },
      { chatId: 6964248629, username: "DaryaKach", firstName: "Darya" },
    ];
    for (const sub of knownSubs) {
      await db
        .insert(subscribersTable)
        .values({
          chatId: sub.chatId,
          username: sub.username,
          firstName: sub.firstName,
          lastName: null,
          active: true,
        })
        .onConflictDoUpdate({
          target: subscribersTable.chatId,
          set: {
            // Do NOT unconditionally set active: true — if subscribed_until has
            // passed the expiry job will have deactivated this subscriber; a
            // restart must not silently re-enable them.
            username: sub.username,
            firstName: sub.firstName,
          },
        });
    }
    logger.info(
      { count: knownSubs.length },
      "Startup seed: known subscribers activated",
    );
  } catch (err) {
    logger.warn({ err }, "Startup seed subscribers: ошибка (non-critical)");
  }
}

// ── pg Pool error handler ──────────────────────────────────────────────────────
// Neon serverless периодически рвёт idle-соединения. Без обработчика 'error'
// Node.js бросает uncaughtException и процесс может упасть.
// Pool автоматически создаёт новое соединение при следующем запросе.
pool.on("error", (err) => {
  logger.warn(
    { err: String(err) },
    "pg pool: idle client error (Neon closed connection) — pool will reconnect automatically",
  );
});

// ── Глобальная защита от падения процесса ─────────────────────────────────────
// Без этого Node.js завершает процесс при любом необработанном промисе/исключении.
process.on("unhandledRejection", (reason, promise) => {
  const rejection =
    reason instanceof Error
      ? {
          name: reason.name,
          message: reason.message,
          stack: reason.stack,
        }
      : { value: String(reason) };
  logger.error(
    { rejection, promise: String(promise) },
    "⚠️ Unhandled promise rejection — caught, server stays alive",
  );
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "⚠️ Uncaught exception — caught, server stays alive");
});

// ── Graceful shutdown при деплое (SIGTERM от Replit) ──────────────────────────
// Останавливаем планировщик сканера, даём текущим операциям завершиться (10 сек),
// затем выходим чисто — без обрыва на середине скана или отправки Telegram.
let isShuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(
    { signal },
    "Graceful shutdown: получен сигнал, останавливаем сканер...",
  );
  try {
    await stopScanner();
  } catch {
    /* non-critical */
  }
  // Ждём 5 секунд чтобы текущие DB/Telegram операции завершились
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  logger.info("Graceful shutdown: завершено, выходим");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startProcessHealthSampler();

  // Webhook регистрируем ТОЛЬКО в production.
  // В dev-режиме dev-домен (.replit.dev) умирает при idle и перебивает
  // продакшн-webhook, из-за чего бот теряет все апдейты от Telegram.
  const domains = process.env.REPLIT_DOMAINS;
  if (domains && process.env.NODE_ENV !== "development") {
    const domain = domains.split(",")[0].trim();
    const webhookUrl = `https://${domain}/api/telegram/webhook`;

    const inboxReady = await ensureTelegramWebhookInbox();
    const ok = inboxReady && (await setWebhook(webhookUrl));
    if (ok) {
      logger.info({ webhookUrl }, "Telegram webhook registered");
    } else {
      logger.warn(
        "Failed to register Telegram webhook — bot subscriptions may not work",
      );
    }
    await registerBotCommands();
  } else if (process.env.NODE_ENV === "development") {
    logger.info(
      "DEV mode — webhook registration skipped (production webhook preserved)",
    );
  } else {
    logger.info("REPLIT_DOMAINS not set, skipping webhook registration");
  }

  // Do not start the external order relay until production-only position
  // corrections have completed. A schema retry may finish during startup.
  let tradingRelaySchemaReady = false;
  let tradingCorrectionsReady = false;
  let tradingRelayStarted = false;
  const startTradingRelayWhenSafe = () => {
    if (
      tradingRelaySchemaReady &&
      tradingCorrectionsReady &&
      !tradingRelayStarted
    ) {
      startTradingSignalRelay();
      startTradingCommandRelay();
      tradingRelayStarted = true;
    }
  };
  // A single connection timeout on a startup schema gate must not stop a fresh
  // deployment (these gates exit the process on failure). Only connection-level
  // failures are retried; schema/SQL errors still fail immediately.
  const startupDbRetry = async (
    gate: () => Promise<unknown>,
  ): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        await gate();
        return;
      } catch (err) {
        const text = String(
          (err as { cause?: unknown })?.cause ?? (err as Error)?.message ?? err,
        );
        const connectionLevel =
          /connection timeout|Connection terminated|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(
            text,
          );
        if (!connectionLevel || attempt >= 5) throw err;
        logger.warn(
          { err, attempt },
          "Startup schema gate hit a database connection error; retrying",
        );
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  };
  // A cold database connection can time out on the very first query; several
  // schema gates below exit the process on failure, which crash-loops a fresh
  // deployment. Wait for the database before running them.
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      await db.execute(drizzleSql`SELECT 1`);
      break;
    } catch (err) {
      logger.warn(
        { err, attempt },
        "Database not reachable at startup; retrying",
      );
      if (attempt === 12) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  try {
    await startupDbRetry(assertSchedulerLeaseSchema);
    logger.info("Scheduler lease schema ready");
    await startupDbRetry(ensureBtcRegimeSchema);
    logger.info("BTC regime observation schema ready");
    await startupDbRetry(ensureBtcDominanceObservationsSchema);
    logger.info("BTC dominance observation schema ready");
    await startupDbRetry(ensureBtcCrossAlertsSchema);
    logger.info("BTC crossing alert schema ready");
    // Collect independently of signals and dashboard visits. The unique
    // (source, observed_at) key also makes concurrent server workers safe.
    const collectDominance = () => {
      void getBitcoinDominanceSummary()
        .then(() => reconcileBtcCrossAlerts())
        .catch((err) =>
          logger.warn(
            { err },
            "Scheduled BTC dominance collection/reconciliation failed",
          ),
        );
    };
    setTimeout(collectDominance, 2 * 60_000);
    setInterval(collectDominance, 60 * 60_000);
    const initializeTradingRelay = async (): Promise<void> => {
      try {
        await startupDbRetry(ensureTradingSignalRelaySchema);
        logger.info("Trading signal relay schema ready");
        await startupDbRetry(ensureTradingCommandOutboxSchema);
        logger.info("Trading command outbox schema ready");
        tradingRelaySchemaReady = true;
        startTradingRelayWhenSafe();
      } catch (error) {
        logger.error(
          { err: error },
          "Trading signal relay unavailable; retrying without blocking primary scanner",
        );
        setTimeout(() => void initializeTradingRelay(), 60_000);
      }
    };
    await initializeTradingRelay();
    await startupDbRetry(ensureScannerRecoverySchema);
    logger.info("Scanner recovery schema ready");
    await startupDbRetry(ensureTelegramPhotoOutboxSchema);
    logger.info("Telegram photo outbox schema ready");
    const disabledStealthObservations =
      await quarantineDisabledStealthObservationDeliveries();
    if (disabledStealthObservations > 0) {
      logger.warn(
        { disabledStealthObservations },
        "Disabled standalone Stealth TA observations quarantined",
      );
    }
    const quarantinedOperatorAlerts =
      await quarantinePendingOperatorFailureAlerts();
    if (quarantinedOperatorAlerts > 0) {
      logger.warn(
        { quarantinedOperatorAlerts },
        "Pending Telegram operator-alert flood quarantined",
      );
    }
    await startupDbRetry(ensureMilestoneDeliverySchema);
    logger.info("Milestone delivery schema ready");
    await startupDbRetry(ensureTrailingAnalyticsSchema);
    logger.info("Trailing analytics schema ready");
    const quarantinedRetries = await quarantineAmbiguousTelegramRetries();
    if (quarantinedRetries > 0) {
      logger.warn(
        { quarantinedRetries },
        "Ambiguous Telegram retry rows quarantined during startup",
      );
    }
    const reconciledAmbiguousAudit =
      await reconcileAmbiguousTelegramDeliveryAudit();
    if (reconciledAmbiguousAudit > 0) {
      logger.warn(
        { reconciledAmbiguousAudit },
        "Telegram unknown-outcome audit reconciled during startup",
      );
    }
    const quarantinedMilestones =
      await quarantineExpiredMilestoneRecipients(db);
    if (quarantinedMilestones > 0) {
      logger.warn(
        { quarantinedMilestones },
        "Expired milestone sends quarantined during startup",
      );
    }
    try {
      await logTelegramDeliveryHealth("startup");
    } catch (err) {
      logger.warn(
        { err },
        "Could not read Telegram delivery health at startup",
      );
    }
  } catch (err) {
    logger.fatal(
      { err },
      "Telegram photo outbox schema unavailable — watcher will not start",
    );
    process.exit(1);
  }
  try {
    await ensureTradeCalculatorSchema();
    logger.info("Trade calculator schema ready");
  } catch (err) {
    logger.fatal(
      { err },
      "Trade calculator schema unavailable — watcher will not start",
    );
    process.exit(1);
  }
  try {
    await ensureDashboardPresenceSchema();
    logger.info("Dashboard presence schema ready");
  } catch (err) {
    logger.warn({ err }, "Dashboard presence schema unavailable");
  }
  try {
    await ensureHealthOutcomesSchema();
    logger.info("Health and outcomes schema ready");
  } catch (err) {
    logger.warn({ err }, "Health and outcomes schema unavailable");
  }
  try {
    await ensureImpulseBuyShadowSchema();
    logger.info("Impulse Buy shadow schema ready");
  } catch (err) {
    logger.fatal(
      { err },
      "Impulse Buy shadow schema unavailable — scanner will not start",
    );
    process.exit(1);
  }
  try {
    await ensurePlmDecisionSnapshotSchema();
    logger.info("PLM decision snapshot schema ready");
  } catch (err) {
    logger.fatal(
      { err },
      "PLM decision snapshot schema unavailable — scanner will not start",
    );
    process.exit(1);
  }
  try {
    await ensurePatternDecisionHistorySchema();
    logger.info("Pattern decision history schema ready");
  } catch (err) {
    logger.fatal(
      { err },
      "Pattern decision history schema unavailable — scanner will not start",
    );
    process.exit(1);
  }
  try {
    await ensureLiqCascadeObservationSchema();
    logger.info("Liquidation Cascade observation schema ready");
  } catch (err) {
    logger.warn(
      { err },
      "Liquidation Cascade observation schema unavailable — trading continues without LC observation writes",
    );
  }
  try {
    await ensurePositionTrackingSchema();
    logger.info("Position tracking schema ready");
  } catch (err) {
    logger.fatal(
      { err },
      "Position tracking schema unavailable — watcher will not start",
    );
    process.exit(1);
  }
  try {
    await ensureScanRejectZoneColumns();
    logger.info("Scan reject-log zone columns ready");
  } catch (err) {
    logger.fatal(
      { err },
      "Scan reject-log zone columns unavailable — scanner will not start",
    );
    process.exit(1);
  }
  try {
    await ensureReentryShadowSchema();
    logger.info("Re-entry shadow schema ready");
  } catch (err) {
    logger.fatal(
      { err },
      "Re-entry shadow schema unavailable — watcher will not start",
    );
    process.exit(1);
  }
  try {
    await ensureTrackedStatusSchema();
    logger.info("Tracked status schema ready");
  } catch (err) {
    logger.fatal(
      { err },
      "Tracked status schema unavailable — watcher will not start",
    );
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production") {
    // Reviewed one-off closes must never block boot: a failure is logged and
    // retried on the next start (the close is idempotent).
    try {
      const legacyWhale = await neutralizeLegacyWhaleSignals();
      logger.info(
        legacyWhale,
        "Legacy Whale Futures excluded from statistics; reviewed no-breakout Stealth closed neutrally",
      );
    } catch (err) {
      logger.error({ err }, "Legacy Whale Futures neutral close failed");
    }
    try {
      const ibNeutralized = await neutralizeReviewedImpulseBuySignals();
      logger.info(
        { ibNeutralized },
        "Reviewed Impulse Buy positions closed neutrally in dashboard",
      );
    } catch (err) {
      logger.error({ err }, "Reviewed Impulse Buy neutral close failed");
    }
    try {
      const plmClosed = await neutralizePlmP24hSignals();
      logger.info(
        { plmClosed },
        "PLM positions below the restored p24h bound closed neutrally",
      );
    } catch (err) {
      logger.error({ err }, "PLM p24h neutral close failed");
    }
    try {
      const plmNegative = await reclassifyPlmNegativeTrades();
      logger.info(
        { plmNegative },
        "Negative closed PLM trades removed from statistics",
      );
    } catch (err) {
      logger.error({ err }, "PLM negative reclassification failed");
    }
    try {
      const plmRetired = await neutralizeOpenPlmSignals();
      logger.info({ plmRetired }, "Open PLM positions closed neutrally");
    } catch (err) {
      logger.error({ err }, "PLM retirement neutral close failed");
    }
    try {
      const neutralized =
        await neutralizeReviewedBalancedGrindDashboardSignals();
      logger.info(
        { neutralized },
        "Reviewed Balanced Grind positions closed neutrally in dashboard",
      );
    } catch (err) {
      logger.fatal(
        { err },
        "Balanced Grind dashboard close failed — watcher will not start",
      );
      process.exit(1);
    }
    try {
      const result =
        await neutralizeReviewedStealthResistanceDashboardSignals();
      if (result.partialRunners.length || result.missing.length) {
        logger.warn(
          result,
          "Stealth Resistance neutral close: some reviewed positions were skipped",
        );
      } else {
        logger.info(result, "Stealth Resistance neutral close reviewed");
      }
    } catch (err) {
      logger.fatal(
        { err },
        "Stealth Resistance dashboard close failed — watcher will not start",
      );
      process.exit(1);
    }
    try {
      const volumeClose = await neutralizeReviewedStealthVolumeGateSignals();
      logger.info(volumeClose, "Stealth volume-gate neutral close reviewed");
    } catch (err) {
      // Non-fatal: the transaction rolled back, positions stay unchanged.
      logger.error({ err }, "Stealth volume-gate neutral close failed");
    }
    try {
      const neonVolumeClose = await neutralizeNeonVolumeGateSignals();
      logger.info(
        neonVolumeClose,
        "Neon 4x volume-gate neutral close reviewed",
      );
    } catch (err) {
      // Non-fatal: the transaction rolled back, positions stay unchanged.
      logger.error({ err }, "Neon 4x volume-gate neutral close failed");
    }
    try {
      const initClose = await reclassifyOwnerReviewedInitNoBreakout();
      logger.info(
        { count: initClose },
        "Stealth INIT no-breakout correction reviewed",
      );
    } catch (err) {
      logger.error({ err }, "Stealth INIT no-breakout correction failed");
    }
    try {
      const openClose = await neutralizeOpenStealthSignals();
      logger.info(openClose, "Open Stealth positions neutral close reviewed");
    } catch (err) {
      logger.error({ err }, "Open Stealth neutral close failed");
    }
    try {
      const aggregatedClose = await neutralizeNonAggregatedOpenPositions();
      logger.info(
        aggregatedClose,
        "Non-aggregated data neutral close reviewed",
      );
    } catch (err) {
      // Non-fatal: the transaction rolled back, positions stay unchanged.
      logger.error({ err }, "Non-aggregated data neutral close failed");
    }
    try {
      const opClose = await neutralizeOpOpenNeonPosition();
      logger.info(opClose, "OP neon neutral close reviewed");
    } catch (err) {
      logger.error({ err }, "OP neon neutral close failed");
    }
    try {
      const restored = await restoreNeonRowsClosedByZoneRule();
      logger.warn({ restored }, "Neon rows closed by zone rule restored");
    } catch (err) {
      logger.error({ err }, "Neon zone-rule restore failed");
    }
    try {
      const recalc = await applyNeonNoWaitRecalc();
      logger.warn(recalc, "Neon no-wait October recalculation reviewed");
    } catch (err) {
      logger.error({ err }, "Neon no-wait October recalculation failed");
    }
    try {
      const removal = await removeNeonOpenNoWaitPositions();
      logger.warn(removal, "Neon open no-wait removal reviewed");
    } catch (err) {
      logger.error({ err }, "Neon open no-wait removal failed");
    }
  }
  try {
    const reclassifiedLiqCascade =
      await reclassifyReviewedOpenLiqCascadeSpikes();
    if (reclassifiedLiqCascade > 0) {
      logger.warn(
        { reclassifiedLiqCascade },
        "Reviewed open Liquidation Cascade spikes moved back to observation",
      );
    }
  } catch (err) {
    logger.fatal(
      { err },
      "Reviewed Liquidation Cascade correction failed — watcher will not start",
    );
    process.exit(1);
  }
  try {
    const closedReviewedLc = await neutralCloseReviewedLcPositions();
    if (closedReviewedLc > 0) {
      logger.warn(
        { closedReviewedLc },
        "Owner-reviewed LC positions closed neutrally",
      );
    }
  } catch (err) {
    logger.fatal(
      { err },
      "LC reviewed neutral close failed — watcher will not start",
    );
    process.exit(1);
  }
  try {
    const movedNoObLc = await moveReviewedNoObLcToWait();
    if (movedNoObLc > 0) {
      logger.warn(
        { movedNoObLc },
        "Open LC positions without a lower OB moved to OB waiting",
      );
    }
  } catch (err) {
    logger.fatal({ err }, "LC no-OB wait move failed — watcher will not start");
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production") {
    try {
      await repairImpulseRunnerCanonicalAccounting(logger);
    } catch (err) {
      logger.fatal(
        { err },
        "Impulse runner canonical accounting repair unavailable — watcher will not start",
      );
      process.exit(1);
    }
    try {
    } catch (err) {
      logger.fatal(
        { err },
        "BR impulse runner close correction unavailable — watcher will not start",
      );
      process.exit(1);
    }
    try {
      await reclassifyOpenBullishAccumulationPositions();
    } catch (err) {
      logger.fatal(
        { err },
        "Bullish Accumulation startup correction unavailable — watcher will not start",
      );
      process.exit(1);
    }
    try {
      await reclassifyOpenImpulseBuyPositionsExcludedByCurrentGates();
      await reclassifyOpenPlmPositionsExcludedByP3hGate();
      await reclassifyInvalidOpenNeonSupportPosition();
      await reclassifyInvalidOpenStealthBreakoutPositions();
      await reclassifyReviewedOpenStealthBreakouts();
      const reviewedStealthCount =
        await reclassifyReviewedStealthOneHourFailures();
      logger.info(
        { count: reviewedStealthCount },
        "Reviewed Stealth 1H failures moved to neutral observation",
      );
      const insideRangeCount =
        await reclassifyReviewedStealthInsideRangeEntry();
      logger.info(
        { count: insideRangeCount },
        "Reviewed Stealth inside-range entry moved to waiting",
      );
    } catch (err) {
      logger.fatal(
        { err },
        "Entry-gate startup correction unavailable — watcher will not start",
      );
      process.exit(1);
    }
  }
  tradingCorrectionsReady = true;
  startTradingRelayWhenSafe();
  // Non-fatal, background: must never block or crash startup.
  void backfillOpenStealthBreakoutVolume()
    .then((count) =>
      logger.info({ count }, "Open Stealth breakout volume backfilled"),
    )
    .catch((err) =>
      logger.warn({ err }, "Open Stealth breakout volume backfill failed"),
    );
  startRangeDeviationFollowup();
  void backfillOpenRangeDeviation()
    .then((count) =>
      logger.info({ count }, "Open positions Range/deviation backfilled"),
    )
    .then(() => backfillLc15mRange())
    .then((count) => logger.info({ count }, "LC 15m Range backfilled"))
    .then(() => backfillLcDetectionVolume())
    .then((count) => logger.info({ count }, "LC detection volume backfilled"))
    .catch((err) =>
      logger.warn({ err }, "Open positions Range/deviation backfill failed"),
    );
  try {
    await ensureBreakoutAnalysisSchema();
    logger.info("Breakout analysis schema ready");
  } catch (err) {
    logger.fatal(
      { err },
      "Breakout analysis schema unavailable — scanner will not start",
    );
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production") {
    try {
      await invalidateLegacyStealthQuietZoneArms();
    } catch (err) {
      logger.fatal(
        { err },
        "Legacy 1H Stealth arm invalidation failed — scanner will not start",
      );
      process.exit(1);
    }
    try {
      await deleteInvalidStealthQuietZoneTrades();
    } catch (err) {
      logger.fatal(
        { err },
        "Invalid Stealth quiet-zone deletion correction failed — scanner will not start",
      );
      process.exit(1);
    }
  }
  try {
    await ensureAltBulletSnapshotRetrySchema();
    logger.info("AltBullet snapshot retry schema ready");
  } catch (err) {
    logger.fatal(
      { err },
      "AltBullet snapshot retry schema unavailable — watcher will not start",
    );
    process.exit(1);
  }
  try {
    // This additive table is created in both dev and production before either
    // the watcher or scanner can begin writing observation rows.
    await ensureIndicatorTargetObservationsSchema();
    logger.info("Indicator target observation schema ready");
  } catch (err) {
    logger.fatal(
      { err },
      "Indicator target observation schema unavailable — watcher will not start",
    );
    process.exit(1);
  }
  try {
    await ensureStealthVerdictJournalSchema();
    logger.info("Stealth verdict journal schema ready");
  } catch (err) {
    logger.fatal(
      { err },
      "Stealth verdict journal schema unavailable — scanner will not start",
    );
    process.exit(1);
  }
  try {
    await ensureCoinglassCycleMetricsSchema();
    await ensureCoinglassArmTraceSchema();
    await ensureAutoRangeHistoryStoreSchema();
    await hydrateAutoRangeHistoryFromDb();
  } catch (err) {
    // Observability/cache only: degrade to the in-memory behaviour, loudly.
    logger.error(
      { err },
      "CoinGlass metrics / Auto Range history store unavailable — continuing without persistence",
    );
  }
  try {
    await ensureLcObWaitSchema();
    logger.info("LC OB wait schema ready");
  } catch (err) {
    logger.fatal(
      { err },
      "LC OB wait schema unavailable — watcher will not start",
    );
    process.exit(1);
  }
  try {
    await ensureLcWaitingShadowSchema();
    logger.info("LC waiting shadow schema ready");
  } catch (err) {
    logger.fatal(
      { err },
      "LC waiting shadow schema unavailable — watcher will not start",
    );
    process.exit(1);
  }
  try {
    await ensureLcStopBidSchema();
    logger.info("LC stop bid observation schema ready");
  } catch (err) {
    logger.fatal(
      { err },
      "LC stop bid schema unavailable — watcher will not start",
    );
    process.exit(1);
  }
  try {
    await ensureLcRapidReboundSchema();
    logger.info("LC rapid rebound observation schema ready");
  } catch (err) {
    logger.warn(
      { err },
      "LC rapid rebound observation schema unavailable — optional observation worker disabled",
    );
  }
  try {
    // Smart Money observation retired: remove its table (and indexes) everywhere.
    await db.execute(
      drizzleSql`DROP TABLE IF EXISTS smart_money_shadow_observations`,
    );
    logger.info("Smart Money shadow table removed");
  } catch (err) {
    logger.warn(
      { err },
      "Smart Money shadow table drop failed; will retry on next start",
    );
  }
  try {
    await ensureProtectedCloseAuditSchema();
    startProtectedCloseAuditMonitor();
    logger.info("Protected close evidence schema and monitor ready");
  } catch (err) {
    logger.fatal(
      { err },
      "Protected close evidence unavailable — watcher will not start",
    );
    process.exit(1);
  }
  try {
    await ensurePostCloseFollowupSchema();
    logger.info("Post-close follow-up schema ready");
  } catch (err) {
    logger.fatal(
      { err },
      "Post-close follow-up schema unavailable — hourly outcomes will not start",
    );
    process.exit(1);
  }
  // One-time migration: перенос позиций из dev в prod (30.05.2026)
  if (process.env.NODE_ENV !== "development") {
    try {
      await ensurePrescanTelemetryIdempotencySchema();
      logger.info("Prescan telemetry idempotency schema ready");
    } catch (err) {
      logger.fatal(
        { err },
        "Prescan telemetry idempotency schema unavailable — scanner will not start",
      );
      process.exit(1);
    }
    if (process.env.NODE_ENV === "production") {
      try {
        await deleteInvalidCancelledImpulseBuyTrades();
      } catch (err) {
        logger.fatal(
          { err },
          "Invalid cancelled Impulse Buy deletion correction failed — watcher will not start",
        );
        process.exit(1);
      }
    }
    if (process.env.RUN_STARTUP_MAINTENANCE === "true") {
      runStartupMigration().catch(() => {
        /* logged inside */
      });
    } else {
      logger.info(
        "Heavy startup maintenance is disabled; use the normal schema migration flow",
      );
    }
  }

  // The scanner is allowed to bring its own required state online first. These
  // jobs are useful but optional and can create a large HTTP/DB burst on cold
  // start, exactly when discovery needs the pool to establish safe ownership.
  let postDiscoveryWarmupsStarted = false;
  const startPostDiscoveryWarmups = () => {
    if (postDiscoveryWarmupsStarted) return;
    postDiscoveryWarmupsStarted = true;
    startMarketCapPreloader();
    startExchangeListRefresher();
    warmChannelIdCache().catch((err) =>
      logger.warn({ err }, "warmChannelIdCache failed"),
    );

    // Any signal whose process died or lost the DB connection before its
    // recipient outbox insert is retried with the same business event identity.
    // Single-flight + cross-worker advisory-lock guards inside reconcile ensure
    // overlapping ticks and parallel workers are safe.
    const runReconcile = () =>
      runOptionalDbJob(
        "primary-signal-alert-reconciliation",
        getScannerDbAdmissionBlocker() !== null,
        reconcilePendingSignalAlerts,
      )
        .then((result) => {
          if (!result.ran) {
            logger.debug(
              { reason: result.reason },
              "Primary signal alert reconciliation deferred by scanner DB priority",
            );
            return;
          }
          const recovered = result.value;
          if (recovered > 0)
            logger.info(
              { recovered },
              "scheduled reconcile: primary signal alerts recovered",
            );
        })
        .catch((err) =>
          logger.warn({ err }, "primary signal alert reconciliation failed"),
        );

    setTimeout(runReconcile, 30_000);
    setInterval(runReconcile, 2 * 60 * 1000);

    // Observation only: never gate LC firing/delivery on this worker.
    const runLcShadow = () =>
      runOptionalDbJob(
        "lc-waiting-shadow",
        getScannerDbAdmissionBlocker() !== null,
        () =>
          runWhenMarketCycleIdle(
            isMarketCycleLeaseBusy,
            runLcWaitingShadowCycle,
          ),
      ).catch((err) => logger.warn({ err }, "LC waiting shadow cycle failed"));
    setTimeout(runLcShadow, 45_000);
    setInterval(runLcShadow, 5 * 60 * 1000);

    // Observation-only PONS-like rapid rebound tracking; never affects LC gates.
    // The worker is bounded to four watch candidates and only runs while idle.
    const runLcRapidRebound = () =>
      runOptionalDbJob(
        "lc-rapid-rebound-observation",
        getScannerDbAdmissionBlocker() !== null,
        () =>
          runWhenMarketCycleIdle(
            isMarketCycleLeaseBusy,
            runLcRapidReboundCycle,
          ),
      ).catch((err) =>
        logger.warn({ err }, "LC rapid rebound observation cycle failed"),
      );
    setTimeout(runLcRapidRebound, 90_000);
    setInterval(runLcRapidRebound, 5 * 60 * 1000);

    // Fills historical OI/CVD/taker at the crossing time of Stealth arms
    // (separate field, never mixed with live captures).
    const runStealthBackfill = () =>
      runOptionalDbJob(
        "stealth-participation-backfill",
        getScannerDbAdmissionBlocker() !== null,
        () =>
          runWhenMarketCycleIdle(isMarketCycleLeaseBusy, async () => {
            await runStealthParticipationBackfillCycle();
          }),
      ).catch((err) =>
        logger.warn({ err }, "Stealth participation backfill failed"),
      );
    setTimeout(runStealthBackfill, 120_000);
    setInterval(runStealthBackfill, 3 * 60 * 1000);

    // Per-candle snapshots after every detected Stealth breakout (fired or not).
    const runStealthCandleSnapshots = () =>
      runOptionalDbJob(
        "stealth-breakout-candle-snapshots",
        getScannerDbAdmissionBlocker() !== null,
        async () => {
          await ensureStealthBreakoutCandleSnapshotsSchema();
          await runStealthBreakoutCandleSnapshotCycle();
        },
      ).catch((err) =>
        logger.warn({ err }, "Stealth candle snapshots failed (non-critical)"),
      );
    // Reconstructed entry-candle analysis for open positions that lack it.
    const runEntryCandleAnalysisBackfill = () =>
      runOptionalDbJob(
        "entry-candle-analysis-backfill",
        getScannerDbAdmissionBlocker() !== null,
        async () => {
          await runEntryCandleAnalysisBackfillCycle();
        },
      ).catch((err) =>
        logger.warn({ err }, "Entry candle analysis backfill failed"),
      );
    setTimeout(runEntryCandleAnalysisBackfill, 180_000);
    setInterval(runEntryCandleAnalysisBackfill, 5 * 60 * 1000);
    const runStealthCutoffOutcomes = () =>
      runOptionalDbJob(
        "stealth-cutoff-outcomes",
        getScannerDbAdmissionBlocker() !== null,
        () => runStealthCutoffOutcomeCycle(),
      ).catch((err) =>
        logger.warn({ err }, "Stealth cutoff outcomes failed (non-critical)"),
      );
    setTimeout(runStealthCutoffOutcomes, 180_000);
    setInterval(runStealthCutoffOutcomes, 30 * 60 * 1000);
    setTimeout(runStealthCandleSnapshots, 150_000);
    setInterval(runStealthCandleSnapshots, 5 * 60 * 1000);

    // CG supported-coins whitelist — основа классификации BingX-exclusive vs CG-covered.
    // Загружаем при старте, обновляем каждые 12ч.
    refreshCgSupportedCoins().catch((err) =>
      logger.warn({ err }, "refreshCgSupportedCoins: первый запуск не удался"),
    );
    setInterval(
      () => {
        refreshCgSupportedCoins().catch((err) =>
          logger.warn(
            { err },
            "refreshCgSupportedCoins: ошибка планового обновления",
          ),
        );
      },
      12 * 60 * 60 * 1000,
    );

    // Binance spot listings — проактивный список Binance-спот токенов.
    // Используется в: isBingxExclusive().
    // Загружаем при старте, обновляем каждые 6ч.
    refreshBinanceSpotListings().catch((err) =>
      logger.warn(
        { err },
        "refreshBinanceSpotListings: первый запуск не удался",
      ),
    );
    setInterval(
      () => {
        refreshBinanceSpotListings().catch((err) =>
          logger.warn(
            { err },
            "refreshBinanceSpotListings: ошибка планового обновления",
          ),
        );
      },
      6 * 60 * 60 * 1000,
    );
  };

  // В dev-режиме сканер и watcher НЕ запускаются — только production.
  // Причина: dev-инстанс подключён к тем же BingX API ключам и той же сети,
  // что и prod. Если оба экземпляра сканируют одновременно, они детектируют
  // сигналы в разное время и пишут в разные БД (dev vs prod).
  // Результат: дашборд (dev) и Telegram (prod) показывают разные позиции.
  // В dev нужно только разрабатывать код — реальный трейдинг идёт через prod.

  if (process.env.NODE_ENV === "development") {
    logger.info(
      "DEV mode — scanner NOT started; watcher started (Telegram suppressed)",
    );
    // Watcher runs in dev to keep signal statuses accurate (stop_loss / profit / cancelled).
    // All Telegram sends are suppressed via sendMessage() guard in telegram.ts.
    startPostDiscoveryWarmups();
    startWatcher();
  } else {
    let workerRestartRequested = false;
    const requestWorkerRestart = async (): Promise<void> => {
      if (workerRestartRequested) return;
      workerRestartRequested = true;
      logger.fatal(
        "Scanner recovery requires a worker restart; exiting for the supervisor",
      );
      // Do not try to clear a live settlement fence in-process. A non-zero
      // exit lets the workflow/deployment supervisor create a fresh worker;
      // the durable discovery lease remains the cross-worker safety fence.
      const exitTimer = setTimeout(() => process.exit(1), 1_000);
      exitTimer.unref();
    };
    setScannerWorkerRestartHandler((details) => {
      logger.fatal(
        { details },
        "Scanner settlement fence requested worker restart",
      );
      void requestWorkerRestart();
    });

    // The first discovery cycle gets the network and DB pool to itself.
    // Watcher/reconciliation timers are optional on cold start and previously
    // competed with initial discovery before caches and scanner state were
    // restored.
    const startAfterRequestedStops = async (): Promise<void> => {
      try {
        // Remove excluded open positions before any close checks, scanner
        // cycle, or notification workers can act on them.
        await reclassifyOpenExcludedSignalSymbols();
        await closeOverdueImpulseRunnersBeforeScanner();
        await closeRequestedLossesBeforeScanner();
      } catch (err) {
        logger.error(
          { err },
          "Pre-scanner position reconciliation failed; scanner paused, retrying",
        );
        setTimeout(() => void startAfterRequestedStops(), 30_000);
        return;
      }
      try {
        await startScanner();
        startPostDiscoveryWarmups();
        startWatcher();
        startWatchdog(
          getLastScanAt,
          requestWorkerRestart,
          getScannerActivityState,
          getDiscoveryScannerLeaseStatus,
          getScannerRecoveryState,
        );
        logger.info(
          "Watcher started after operator-requested closes and scanner initialization",
        );
      } catch (err) {
        logger.error({ err }, "Failed to auto-start scanner");
      }
    };
    void startAfterRequestedStops();

    // Бэкфилл growth_leader_log — ОТКЛЮЧЁН (2026-07-18): запись лидеров роста остановлена.

    // ── Part 2: Forward-accumulation jobs ─────────────────────────────────────
    const runDeferredMarketTimer = async (
      name: string,
      job: () => Promise<void>,
      priority = false,
    ): Promise<void> => {
      const result = await runOptionalDbJob(
        name,
        getScannerDbAdmissionBlocker() !== null,
        () => runWhenMarketCycleIdle(isMarketCycleLeaseBusy, job),
        { priority },
      );
      if (!result.ran) {
        logger.debug(
          { job: name, reason: result.reason },
          "Market timer deferred by optional DB admission control",
        );
        return;
      }
      const outcome = result.value;
      if (outcome === "deferred") {
        logger.debug(
          { job: name },
          "Market timer deferred — scanner is active",
        );
      }
    };

    // The row leases make this safe across workers. The timer is only a wake-up:
    // every run also enrolls missed signals, including trades already closed.
    const runIndicatorTargetObservations = () =>
      runDeferredMarketTimer(
        "indicator-target-observations",
        async () => {
          await withSchedulerLease(
            "indicator-target-observations",
            "indicator-target-observations",
            runIndicatorTargetObservationCycle,
            { ttlMs: 10 * 60_000, heartbeatMs: 30_000 },
          );
        },
        true,
      );
    setTimeout(() => {
      runIndicatorTargetObservations().catch((err) =>
        logger.warn({ err }, "Indicator target observation startup run failed"),
      );
    }, 45_000);
    setInterval(() => {
      runIndicatorTargetObservations().catch((err) =>
        logger.warn(
          { err },
          "Indicator target observation scheduled run failed",
        ),
      );
    }, 2 * 60_000);

    const runBtcRegimeObservation = () =>
      runDeferredMarketTimer("btc-regime-observation", async () => {
        await withSchedulerLease(
          BTC_REGIME_LEASE,
          "btc-regime-observation",
          async () => collectBtcRegimeObservation(),
          { ttlMs: 4 * 60_000, heartbeatMs: 30_000 },
        );
      });
    setTimeout(() => {
      runBtcRegimeObservation().catch((err) =>
        logger.warn({ err }, "BTC regime observation: initial run failed"),
      );
    }, 90_000);
    setInterval(() => {
      runBtcRegimeObservation().catch((err) =>
        logger.warn({ err }, "BTC regime observation: scheduled run failed"),
      );
    }, 30 * 60_000);

    // Netflow Collection — taker netflow снапшот каждые 15 мин (100 CoinGlass символов)
    const { runNetflowCollectionJob } =
      await import("./lib/netflow-collection-job.js");
    setTimeout(
      () => {
        runOptionalDbJob(
          "netflow-collection",
          getScannerDbAdmissionBlocker() !== null,
          runNetflowCollectionJob,
        ).catch((err) =>
          logger.warn({ err }, "NetflowCollectionJob: первый запуск не удался"),
        );
      },
      5 * 60 * 1000,
    ); // через 5 мин
    setInterval(
      () => {
        runOptionalDbJob(
          "netflow-collection",
          getScannerDbAdmissionBlocker() !== null,
          runNetflowCollectionJob,
        ).catch((err) =>
          logger.warn({ err }, "NetflowCollectionJob: ошибка цикла"),
        );
      },
      15 * 60 * 1000,
    );

    // Spot NetFlow Cache — batch /api/spot/netflow-list каждые 5 мин
    const { startSpotNetflowRefresh } =
      await import("./lib/spot-netflow-cache.js");
    startSpotNetflowRefresh();
  }

  // Startup notification отправляется из sendBotRestartNotification() через 3 мин —
  // с контекстом открытых сигналов и DB-дедупликацией. Дублировать здесь не нужно.
});

async function ensureTelegramWebhookInbox(): Promise<boolean> {
  try {
    await db.execute(drizzleSql`CREATE TABLE IF NOT EXISTS telegram_updates (
      update_id    bigint PRIMARY KEY,
      status       text NOT NULL DEFAULT 'processing',
      claim_token  text,
      received_at  timestamp NOT NULL DEFAULT now(),
      completed_at timestamp,
      last_error   text
    )`);
    await db.execute(
      drizzleSql`ALTER TABLE telegram_updates ADD COLUMN IF NOT EXISTS claim_token text`,
    );
    const recovered = await db.execute(drizzleSql`
      UPDATE telegram_updates
      SET status = 'completed',
          completed_at = COALESCE(completed_at, NOW())
      WHERE status = 'completion_pending'
    `);
    const recoveredCount = recovered.rowCount ?? 0;
    if (recoveredCount > 0) {
      logger.info(
        { count: recoveredCount },
        "Recovered durable Telegram completion markers",
      );
    }
    await db.execute(
      drizzleSql`CREATE INDEX IF NOT EXISTS telegram_updates_received_at_idx ON telegram_updates (received_at)`,
    );
    return true;
  } catch (err) {
    logger.error({ err }, "Telegram webhook inbox migration failed");
    return false;
  }
}
