import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type ImpulseRunnerAccountingRepairTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

type RepairLogger = {
  warn: (details: Record<string, unknown>, message: string) => void;
  info: (details: Record<string, unknown>, message: string) => void;
};
export async function repairImpulseRunnerCanonicalRows(
  tx: ImpulseRunnerAccountingRepairTransaction,
): Promise<number> {
  const repaired = await tx.execute(sql`
    WITH base AS (
      SELECT id,
             runner_exit_price AS prior_runner_exit_price,
             pnl_percent AS prior_pnl_percent,
             status::text AS prior_status,
             original_entry_price,
             runner_exit_price,
             runner_pnl_percent,
             exit_price,
             peak_price,
             runner_peak_price,
             runner_trailing_stop_level,
             GREATEST(
               COALESCE(peak_price, 0),
               COALESCE(runner_peak_price, 0),
               runner_exit_price
             ) AS corrected_peak
        FROM tracked_signals
       WHERE policy_version = 'impulse_runner_v1'
         AND runner_state = 'closed'
         AND core_closed_at IS NOT NULL
         AND original_entry_price > 0
         AND runner_exit_price > 0
          -- An age expiration is a real observed quote; do not later raise it
          -- to a theoretical stop that was not filled at the time of expiry.
          AND runner_close_event_key IS DISTINCT FROM
            concat('position:', id, ':impulse_runner_v1:runner_close:age_expired')
    ), resolved AS (
      SELECT *,
             CASE WHEN corrected_peak >= original_entry_price * 1.3
               THEN corrected_peak - original_entry_price * 0.3
               ELSE NULL
             END AS earned_trailing_floor,
             CASE
               WHEN runner_trailing_stop_level > 0
                AND runner_trailing_stop_level <= corrected_peak
                 THEN runner_trailing_stop_level
               ELSE NULL
             END AS valid_persisted_trailing_floor
        FROM base
       WHERE runner_trailing_stop_level IS NULL
          OR (
            runner_trailing_stop_level > 0
            AND runner_trailing_stop_level <= corrected_peak
          )
    ), eligible AS (
      SELECT *,
             CASE
               WHEN earned_trailing_floor IS NULL
                AND valid_persisted_trailing_floor IS NULL
                 THEN NULL
               ELSE GREATEST(
                 earned_trailing_floor,
                 valid_persisted_trailing_floor
               )
             END AS effective_trailing_floor
        FROM resolved
    ), calculated AS (
      SELECT *,
             GREATEST(
               runner_exit_price,
               COALESCE(effective_trailing_floor, runner_exit_price)
             ) AS corrected_runner_exit
        FROM eligible
    ), to_repair AS (
      SELECT *,
             (
               corrected_runner_exit - original_entry_price
             ) / NULLIF(original_entry_price, 0) * 100 AS corrected_pnl
        FROM calculated
    ), changed AS (
      SELECT *
        FROM to_repair
       WHERE prior_pnl_percent IS NULL
          OR ABS(prior_pnl_percent - corrected_pnl) > 0.0001
          OR runner_pnl_percent IS NULL
          OR ABS(runner_pnl_percent - corrected_pnl) > 0.0001
          OR runner_exit_price IS DISTINCT FROM corrected_runner_exit
          OR exit_price IS DISTINCT FROM corrected_runner_exit
           OR prior_status <> CASE WHEN corrected_pnl >= 0
             THEN 'profit' ELSE 'stop_loss' END
          OR peak_price IS DISTINCT FROM corrected_peak
          OR runner_peak_price IS DISTINCT FROM corrected_peak
          OR (
            effective_trailing_floor IS NOT NULL
            AND (
              runner_trailing_stop_level IS NULL
              OR runner_trailing_stop_level < effective_trailing_floor
            )
          )
    ), updated AS (
      UPDATE tracked_signals ts
         SET runner_exit_price = e.corrected_runner_exit,
             runner_pnl_percent = e.corrected_pnl,
             runner_peak_price = e.corrected_peak,
             runner_trailing_stop_level = CASE
               WHEN e.effective_trailing_floor IS NOT NULL THEN GREATEST(
                 COALESCE(
                   ts.runner_trailing_stop_level,
                   e.effective_trailing_floor
                 ),
                 e.effective_trailing_floor
               )
               ELSE ts.runner_trailing_stop_level
             END,
             exit_price = e.corrected_runner_exit,
             pnl_percent = e.corrected_pnl,
              status = (CASE WHEN e.corrected_pnl >= 0
                THEN 'profit' ELSE 'stop_loss' END)::tracked_status,
             peak_price = e.corrected_peak,
             updated_at = NOW()
        FROM changed e
       WHERE ts.id = e.id
       RETURNING ts.id,
                 e.prior_runner_exit_price,
                 e.corrected_runner_exit,
                 e.corrected_peak,
                 e.earned_trailing_floor,
                 e.effective_trailing_floor,
                 e.runner_trailing_stop_level AS prior_persisted_trailing_stop,
                 e.prior_pnl_percent,
                 e.prior_status,
                 ts.pnl_percent,
                 ts.status::text,
                 ts.peak_price
    ), floor_audited AS (
      INSERT INTO impulse_runner_trailing_floor_repair_audit (
        tracked_signal_id, prior_runner_exit_price,
        corrected_runner_exit_price, durable_peak_price,
        earned_trailing_floor, effective_trailing_floor,
        prior_persisted_trailing_stop, prior_pnl_percent,
        corrected_pnl_percent
      )
      SELECT id, prior_runner_exit_price, corrected_runner_exit,
             corrected_peak, earned_trailing_floor,
             effective_trailing_floor, prior_persisted_trailing_stop,
             prior_pnl_percent, pnl_percent
        FROM updated
       WHERE corrected_runner_exit > prior_runner_exit_price
      ON CONFLICT (tracked_signal_id) DO UPDATE
        SET corrected_runner_exit_price =
              EXCLUDED.corrected_runner_exit_price,
            durable_peak_price = EXCLUDED.durable_peak_price,
            earned_trailing_floor = EXCLUDED.earned_trailing_floor,
            effective_trailing_floor = EXCLUDED.effective_trailing_floor,
            prior_persisted_trailing_stop =
              EXCLUDED.prior_persisted_trailing_stop,
            corrected_pnl_percent = EXCLUDED.corrected_pnl_percent,
            repaired_at = NOW()
      RETURNING tracked_signal_id
    )
    INSERT INTO impulse_runner_accounting_repair_audit (
      tracked_signal_id, prior_pnl_percent, prior_status,
      corrected_pnl_percent, corrected_status, corrected_peak_price,
      correction_required
    )
    SELECT id, prior_pnl_percent, prior_status,
           pnl_percent, status, peak_price,
           prior_pnl_percent IS NULL
             OR ABS(prior_pnl_percent - pnl_percent) > 0.0001
      FROM updated
    ON CONFLICT (tracked_signal_id) DO UPDATE
      SET corrected_pnl_percent = EXCLUDED.corrected_pnl_percent,
          corrected_status = EXCLUDED.corrected_status,
          corrected_peak_price = EXCLUDED.corrected_peak_price,
          correction_required =
            impulse_runner_accounting_repair_audit.correction_required
            OR EXCLUDED.correction_required,
          repaired_at = NOW()
    RETURNING tracked_signal_id
  `);

  return repaired.rowCount ?? 0;
}

export async function repairImpulseRunnerCanonicalAccounting(
  logger?: RepairLogger,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('impulse_runner_canonical_accounting_v1'))`,
    );
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS impulse_runner_accounting_repair_audit (
        tracked_signal_id integer PRIMARY KEY,
        prior_pnl_percent real,
        prior_status text,
        corrected_pnl_percent real NOT NULL,
        corrected_status text NOT NULL,
        corrected_peak_price real NOT NULL,
        correction_required boolean NOT NULL DEFAULT false,
        repaired_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(sql`
      ALTER TABLE impulse_runner_accounting_repair_audit
        ADD COLUMN IF NOT EXISTS correction_required boolean
          NOT NULL DEFAULT false
    `);
    await tx.execute(sql`
      UPDATE impulse_runner_accounting_repair_audit a
         SET correction_required = true
        FROM tracked_signals t
       WHERE a.tracked_signal_id = t.id
         AND t.id = 1734
         AND t.signal_id = 6316
         AND t.symbol = 'PTB-USDT'
         AND ABS(a.prior_pnl_percent - 11.664393) < 0.0001
         AND ABS(a.corrected_pnl_percent - 34.346012) < 0.0001
         AND NOT EXISTS (
           SELECT 1
             FROM telegram_delivery_events e
            WHERE e.event_key =
              'position:1734:impulse_runner_v1:runner_close_correction:canonical_accounting_v1'
         )
    `);
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS impulse_runner_original_entry_backfill_audit (
        tracked_signal_id integer PRIMARY KEY,
        prior_original_entry_price real,
        source_entry_price real NOT NULL,
        backfilled_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS impulse_runner_accounting_ambiguity_audit (
        tracked_signal_id integer PRIMARY KEY,
        original_entry_price real,
        runner_exit_price real,
        runner_trailing_stop_level real,
        durable_peak_price real,
        core_closed_at timestamp,
        reason text NOT NULL,
        observed_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(sql`
      ALTER TABLE impulse_runner_accounting_ambiguity_audit
        ADD COLUMN IF NOT EXISTS runner_trailing_stop_level real,
        ADD COLUMN IF NOT EXISTS durable_peak_price real
    `);
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS impulse_runner_trailing_floor_repair_audit (
        tracked_signal_id integer PRIMARY KEY,
        prior_runner_exit_price real NOT NULL,
        corrected_runner_exit_price real NOT NULL,
        durable_peak_price real NOT NULL,
        earned_trailing_floor real,
        effective_trailing_floor real,
        prior_persisted_trailing_stop real,
        prior_pnl_percent real,
        corrected_pnl_percent real NOT NULL,
        repaired_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(sql`
      ALTER TABLE impulse_runner_trailing_floor_repair_audit
        ADD COLUMN IF NOT EXISTS effective_trailing_floor real,
        ADD COLUMN IF NOT EXISTS prior_persisted_trailing_stop real
    `);
    await tx.execute(sql`
      WITH eligible AS (
        SELECT id, original_entry_price, entry_price
          FROM tracked_signals
         WHERE policy_version = 'impulse_runner_v1'
           AND entry_policy_version = 'single_entry_v1'
           AND original_entry_price IS NULL
           AND entry_price > 0
         FOR UPDATE
      ), audited AS (
        INSERT INTO impulse_runner_original_entry_backfill_audit
          (tracked_signal_id, prior_original_entry_price, source_entry_price)
        SELECT id, original_entry_price, entry_price FROM eligible
        ON CONFLICT (tracked_signal_id) DO NOTHING
        RETURNING tracked_signal_id
      )
      UPDATE tracked_signals ts
         SET original_entry_price = ts.entry_price,
             updated_at = NOW()
       WHERE ts.id IN (SELECT tracked_signal_id FROM audited)
    `);
    const ambiguous = await tx.execute(sql`
      SELECT id
        FROM tracked_signals
       WHERE policy_version = 'impulse_runner_v1'
         AND runner_state = 'closed'
         AND (
           core_closed_at IS NULL
           OR original_entry_price IS NULL OR original_entry_price <= 0
           OR runner_exit_price IS NULL OR runner_exit_price <= 0
           OR runner_trailing_stop_level <= 0
           OR runner_trailing_stop_level > GREATEST(
             COALESCE(peak_price, 0),
             COALESCE(runner_peak_price, 0),
             COALESCE(runner_exit_price, 0)
           )
         )
       FOR UPDATE
    `);
    if (ambiguous.rowCount) {
      await tx.execute(sql`
        INSERT INTO impulse_runner_accounting_ambiguity_audit (
          tracked_signal_id,
          original_entry_price,
          runner_exit_price,
          runner_trailing_stop_level,
          durable_peak_price,
          core_closed_at,
          reason,
          observed_at
        )
        SELECT id,
               original_entry_price,
               runner_exit_price,
               runner_trailing_stop_level,
               GREATEST(
                 COALESCE(peak_price, 0),
                 COALESCE(runner_peak_price, 0),
                 COALESCE(runner_exit_price, 0)
               ),
               core_closed_at,
               concat_ws(
                 ',',
                 CASE WHEN core_closed_at IS NULL THEN 'missing_core_close' END,
                 CASE WHEN original_entry_price IS NULL OR original_entry_price <= 0
                   THEN 'missing_original_entry' END,
                 CASE WHEN runner_exit_price IS NULL OR runner_exit_price <= 0
                   THEN 'missing_runner_exit' END,
                 CASE WHEN runner_trailing_stop_level <= 0
                   THEN 'invalid_runner_stop' END,
                 CASE WHEN runner_trailing_stop_level > GREATEST(
                   COALESCE(peak_price, 0),
                   COALESCE(runner_peak_price, 0),
                   COALESCE(runner_exit_price, 0)
                 ) THEN 'runner_stop_above_peak' END
               ),
               NOW()
          FROM tracked_signals
         WHERE policy_version = 'impulse_runner_v1'
           AND runner_state = 'closed'
           AND (
             core_closed_at IS NULL
             OR original_entry_price IS NULL OR original_entry_price <= 0
             OR runner_exit_price IS NULL OR runner_exit_price <= 0
             OR runner_trailing_stop_level <= 0
             OR runner_trailing_stop_level > GREATEST(
               COALESCE(peak_price, 0),
               COALESCE(runner_peak_price, 0),
               COALESCE(runner_exit_price, 0)
             )
           )
        ON CONFLICT (tracked_signal_id) DO UPDATE
          SET original_entry_price = EXCLUDED.original_entry_price,
              runner_exit_price = EXCLUDED.runner_exit_price,
              runner_trailing_stop_level =
                EXCLUDED.runner_trailing_stop_level,
              durable_peak_price = EXCLUDED.durable_peak_price,
              core_closed_at = EXCLUDED.core_closed_at,
              reason = EXCLUDED.reason,
              observed_at = EXCLUDED.observed_at
      `);
      logger?.warn(
        { ambiguousRows: ambiguous.rowCount },
        "Impulse runner accounting repair skipped ambiguous closed rows",
      );
    }
    const repairedCount = await repairImpulseRunnerCanonicalRows(tx);
    if (repairedCount > 0) {
      logger?.info(
        { repairedCount },
        "Repaired impulse runner canonical accounting",
      );
    }
  });
}
