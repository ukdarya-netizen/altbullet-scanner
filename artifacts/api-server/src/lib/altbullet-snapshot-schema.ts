import { db } from "@workspace/db";
import { sql as drizzleSql } from "drizzle-orm";

/**
 * AltBullet observation state is required by the normal API startup path.
 * Keep the complete schema in one migration so the retry worker and the
 * immutable snapshot table cannot drift apart.
 */
export async function ensureAltBulletSnapshotRetrySchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('altbullet_snapshot_retry_schema'))`,
    );
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS altbullet_indicator_snapshots (
        id                serial PRIMARY KEY,
        signal_id         integer NOT NULL REFERENCES signals(id),
        symbol            text NOT NULL,
        sentiment_key     text,
        indicator_version text NOT NULL,
        timeframe         text NOT NULL DEFAULT '4h',
        status            text NOT NULL DEFAULT 'ready',
        score             integer,
        verdict           text,
        checks            jsonb,
        context           jsonb,
        audit             jsonb,
        error             text,
        captured_at       timestamp NOT NULL DEFAULT now(),
        UNIQUE (signal_id)
      )
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE altbullet_indicator_snapshots
      ADD COLUMN IF NOT EXISTS audit jsonb
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE signals
      ADD COLUMN IF NOT EXISTS altbullet_snapshot_requested_at timestamp
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE signals
      ADD COLUMN IF NOT EXISTS altbullet_snapshot_claimed_at timestamp
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE signals
      ADD COLUMN IF NOT EXISTS altbullet_snapshot_claim_token text
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE signals
      ADD COLUMN IF NOT EXISTS altbullet_snapshot_attempt_count integer NOT NULL DEFAULT 0
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE signals
      ADD COLUMN IF NOT EXISTS altbullet_snapshot_retry_after timestamp
    `);
    await tx.execute(drizzleSql`
      ALTER TABLE signals
      ADD COLUMN IF NOT EXISTS altbullet_snapshot_last_error text
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS altbullet_indicator_snapshot_verdict_idx
      ON altbullet_indicator_snapshots (verdict)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS altbullet_indicator_snapshot_version_idx
      ON altbullet_indicator_snapshots (indicator_version)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS signals_altbullet_snapshot_pending_idx
      ON signals (altbullet_snapshot_requested_at, altbullet_snapshot_retry_after)
      WHERE altbullet_snapshot_requested_at IS NOT NULL
    `);
    await tx.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS altbullet_take_profit_shadow (
        id                       serial PRIMARY KEY,
        signal_id                integer NOT NULL REFERENCES signals(id),
        tracked_signal_id        integer REFERENCES tracked_signals(id),
        symbol                   text NOT NULL,
        sentiment_key            text,
        indicator_version        text NOT NULL,
        experiment_version       text NOT NULL,
        variant                  text NOT NULL,
        status                   text NOT NULL,
        eligibility_reason       text,
        reference_entry_price    double precision,
        resistance_price         double precision,
        atr14                    double precision,
        target_price             double precision,
        target_pct               double precision,
        target_atr               double precision,
        snapshot_requested_at    timestamp,
        snapshot_captured_at     timestamp NOT NULL,
        enrolled_at              timestamp NOT NULL DEFAULT now(),
        first_observed_at        timestamp,
        first_observed_price     double precision,
        last_observed_at         timestamp,
        last_observed_price      double precision,
        max_observed_at          timestamp,
        max_observed_price       double precision,
        hit_at                   timestamp,
        hit_price                double precision,
        terminal_at              timestamp,
        terminal_status          text,
        terminal_pnl_percent     double precision,
        outcome                  text,
        created_at               timestamp NOT NULL DEFAULT now(),
        updated_at               timestamp NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS altbullet_tp_shadow_signal_variant_unique
      ON altbullet_take_profit_shadow (signal_id, experiment_version, variant)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS altbullet_tp_shadow_tracking_idx
      ON altbullet_take_profit_shadow (status, tracked_signal_id)
    `);
    await tx.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS altbullet_tp_shadow_version_idx
      ON altbullet_take_profit_shadow (indicator_version, experiment_version)
    `);
  });
}
