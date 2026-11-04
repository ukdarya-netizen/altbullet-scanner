import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/** Mandatory, additive runtime gate: the watcher must not fire without this table. */
export async function ensureLcObWaitSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('lc_ob_wait_schema'))`,
    );
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS lc_ob_wait (
        id serial PRIMARY KEY,
        watch_id integer NOT NULL,
        symbol text NOT NULL,
        detected_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        entry_price real NOT NULL,
        zones jsonb NOT NULL DEFAULT '[]'::jsonb,
        invalidated_zones jsonb NOT NULL DEFAULT '[]'::jsonb,
        status text NOT NULL DEFAULT 'waiting'
          CONSTRAINT lc_ob_wait_status_check
          CHECK (status IN ('waiting', 'releasing', 'released', 'expired', 'invalidated')),
        released_at timestamptz,
        release_reason text,
        release_zone jsonb,
        lease_owner text,
        lease_until timestamptz,
        release_window_key text,
        release_signal_id integer,
        current_price real,
        last_check_at timestamptz,
        observation jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(sql`
      ALTER TABLE lc_ob_wait
      ADD COLUMN IF NOT EXISTS invalidated_zones jsonb NOT NULL DEFAULT '[]'::jsonb
    `);
    await tx.execute(sql`
      ALTER TABLE lc_ob_wait
      ADD COLUMN IF NOT EXISTS release_window_key text
    `);
    await tx.execute(sql`
      ALTER TABLE lc_ob_wait
      ADD COLUMN IF NOT EXISTS release_signal_id integer
    `);
    await tx.execute(sql`
      ALTER TABLE lc_ob_wait
      DROP CONSTRAINT IF EXISTS lc_ob_wait_status_check
    `);
    await tx.execute(sql`
      ALTER TABLE lc_ob_wait
      ADD CONSTRAINT lc_ob_wait_status_check
      CHECK (status IN ('waiting', 'releasing', 'released', 'expired', 'invalidated'))
    `);
    await tx.execute(sql`
      DROP INDEX IF EXISTS lc_ob_wait_active_symbol_uniq
    `);
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS lc_ob_wait_active_symbol_uniq
      ON lc_ob_wait (symbol)
      WHERE status IN ('waiting', 'invalidated', 'releasing')
    `);
    await tx.execute(sql`
      DROP INDEX IF EXISTS lc_ob_wait_active_symbol_idx
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS lc_ob_wait_active_symbol_idx
      ON lc_ob_wait (symbol, status)
      WHERE status IN ('waiting', 'invalidated', 'releasing')
    `);
    await tx.execute(
      sql`CREATE INDEX IF NOT EXISTS lc_ob_wait_expires_at_idx ON lc_ob_wait (expires_at)`,
    );
  });
}
