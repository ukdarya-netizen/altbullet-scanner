import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";

/**
 * A BEFORE trigger observes OLD and NEW in the very UPDATE which claims a
 * protected close. An application-side read after the claim cannot tell whether
 * a milestone or peak was already present when the worker made its decision.
 * It never changes the trading outcome, and never backfills historical closes.
 */
type CloseAuditTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

export async function ensureProtectedCloseAuditSchema(): Promise<void> {
  await db.transaction(installProtectedCloseAuditSchema);
}

// Exported so the opt-in integration test can install and exercise the exact
// same DDL entirely inside a rollback-only transaction.
export async function installProtectedCloseAuditSchema(
  tx: CloseAuditTransaction,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('protected_close_audit_schema'))`,
  );
  await tx.execute(sql`
      ALTER TABLE tracked_signals
      ADD COLUMN IF NOT EXISTS protected_close_evidence jsonb
    `);
  await tx.execute(sql`
      ALTER TABLE tracked_signals
      ADD COLUMN IF NOT EXISTS protected_close_alerted_at timestamp
    `);
  await tx.execute(sql`
      CREATE OR REPLACE FUNCTION capture_protected_close_evidence()
      RETURNS trigger LANGUAGE plpgsql AS $protected_close$
      DECLARE
        prior_peak_pct double precision;
        closing_peak_pct double precision;
        expected_floor_pct integer;
        mismatch boolean;
      BEGIN
        IF OLD.protected_close_evidence IS NOT NULL THEN
          NEW.protected_close_evidence := OLD.protected_close_evidence;
          RETURN NEW;
        END IF;
        IF NEW.status::text <> 'bu_stop' OR OLD.status::text = 'bu_stop' THEN
          RETURN NEW;
        END IF;

        prior_peak_pct := CASE
          WHEN OLD.entry_price > 0 AND OLD.peak_price IS NOT NULL AND NOT OLD.is_short
          THEN (OLD.peak_price::double precision / OLD.entry_price::double precision - 1) * 100
          ELSE NULL
        END;
        closing_peak_pct := CASE
          WHEN OLD.entry_price > 0 AND NEW.peak_price IS NOT NULL AND NOT OLD.is_short
          THEN (NEW.peak_price::double precision / OLD.entry_price::double precision - 1) * 100
          ELSE NULL
        END;
        -- Audit the current policy, not an imagined fill. Unknown/legacy shorts
        -- are retained for review but cannot be evaluated with the long floor.
        expected_floor_pct := CASE
          WHEN NOT OLD.is_short AND OLD.entry_price > 0
            AND (OLD.last_milestone >= 10 OR prior_peak_pct >= 10)
          THEN 5
          ELSE 0
        END;
        mismatch := expected_floor_pct = 5 AND (
          NEW.exit_price IS NULL OR NEW.pnl_percent IS NULL
          OR NEW.exit_price::double precision < OLD.entry_price::double precision * 1.04999
          OR NEW.pnl_percent < 4.999
        );
        NEW.protected_close_evidence := jsonb_build_object(
          'version', 1,
          'source', 'atomic_db_close_trigger',
          'capturedAt', clock_timestamp(),
          'priorStatus', OLD.status::text,
          'priorEntryPrice', OLD.entry_price,
          'priorPeakPrice', OLD.peak_price,
          'priorPeakPct', prior_peak_pct,
          'priorMilestone', OLD.last_milestone,
          'priorTrailingStopLevel', OLD.trailing_stop_level,
          'closingPeakPrice', NEW.peak_price,
          'closingPeakPct', closing_peak_pct,
          'closingMilestone', NEW.last_milestone,
          'closedAt', NEW.closed_at,
          'exitPrice', NEW.exit_price,
          'pnlPercent', NEW.pnl_percent,
          'expectedFloorPct', expected_floor_pct,
          'mismatch', mismatch,
          'rule', 'durable_prior_10_protect_5'
        );
        RETURN NEW;
      END;
      $protected_close$
    `);
  await tx.execute(sql`
      DO $protected_close_trigger$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'tracked_signals_protected_close_capture'
            AND tgrelid = 'tracked_signals'::regclass
            AND NOT tgisinternal
        ) THEN
          CREATE TRIGGER tracked_signals_protected_close_capture
          BEFORE UPDATE OF status, protected_close_evidence ON tracked_signals
          FOR EACH ROW
          WHEN (
            OLD.protected_close_evidence IS NOT NULL
            OR (NEW.status = 'bu_stop' AND OLD.status IS DISTINCT FROM NEW.status)
          )
          EXECUTE FUNCTION capture_protected_close_evidence();
        END IF;
      END;
      $protected_close_trigger$
    `);
  await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS tracked_signals_protected_close_pending_idx
      ON tracked_signals (id)
      WHERE protected_close_evidence->>'mismatch' = 'true'
        AND protected_close_alerted_at IS NULL
    `);
}

let monitorStarted = false;

async function checkProtectedCloseMismatches(): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const pending = await tx.execute(sql`
        SELECT id, sentiment_key, protected_close_evidence
        FROM tracked_signals
        WHERE protected_close_evidence->>'mismatch' = 'true'
          AND protected_close_alerted_at IS NULL
        ORDER BY id
        LIMIT 100
        FOR UPDATE SKIP LOCKED
      `);
      for (const row of pending.rows) {
        logger.error(
          {
            trackedSignalId: row.id,
            pattern: row.sentiment_key,
            protectedCloseEvidence: row.protected_close_evidence,
          },
          "Protected B.U. close disagrees with close-time protection evidence",
        );
        await tx.execute(sql`
          UPDATE tracked_signals
          SET protected_close_alerted_at = now()
          WHERE id = ${row.id}
        `);
      }
    });
  } catch (err) {
    logger.error({ err }, "Unable to monitor protected B.U. close evidence");
  }
}

export function startProtectedCloseAuditMonitor(): void {
  if (monitorStarted) return;
  monitorStarted = true;
  void checkProtectedCloseMismatches();
  setInterval(() => void checkProtectedCloseMismatches(), 10 * 60_000).unref();
}
