import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "./logger.js";
import {
  IMPULSE_RUNNER_CORE_WEIGHT,
  IMPULSE_RUNNER_RUNNER_WEIGHT,
} from "./impulse-runner-policy.js";

/**
 * Durable command channel to the external trading bot (PAPER/VST only; this
 * module never enables real orders).
 *
 * - Commands are written by a database trigger on tracked_signals, in the SAME
 *   transaction as the close / stop change, so no tracker code path can change
 *   a relayed position without leaving a command.
 * - Delivery repeats the same commandId until the receiver confirms it STORED
 *   the command. "Stored" is not "executed": execution confirmations arrive
 *   separately (POST /api/trading/command-acks), per environment.
 * - Types: close, move_stop (exact price), cancel_entry (not-yet-filled entry).
 */
export const TRADING_COMMAND_ENDPOINT =
  process.env.TRADING_COMMAND_ENDPOINT ??
  "https://bybit-trading-bot.replit.app/api/trading/commands";
const COMMAND_INTERVAL_MS = 5_000;
const CLAIM_LEASE_SECONDS = 60;
const MAX_BACKOFF_MS = 10 * 60_000;
export const TRADING_COMMAND_TYPES = [
  "close",
  "move_stop",
  "cancel_entry",
] as const;
export type TradingCommandType = (typeof TRADING_COMMAND_TYPES)[number];

export type CommandReceiptOutcome = "accepted" | "quarantined" | "retry";

/**
 * Only an explicit "stored" confirmation for this exact commandId counts.
 * A bare 2xx, a different id or a missing flag is retried: the receiver may
 * have validated the request without persisting it.
 */
export function classifyCommandReceipt(
  status: number,
  body: unknown,
  commandId: string,
): CommandReceiptOutcome {
  const b =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  if (
    b &&
    b.stored === true &&
    b.commandId === commandId &&
    [200, 201, 202, 409].includes(status)
  ) {
    return "accepted";
  }
  if ([400, 422].includes(status)) return "quarantined";
  return "retry";
}

export function commandBackoffMs(attempts: number): number {
  const exp = Math.min(Math.max(attempts, 1) - 1, 10);
  return Math.min(30_000 * 2 ** exp, MAX_BACKOFF_MS);
}

const CLOSE_STATUSES_SQL = `'profit','stop_loss','bu_stop','breakeven','expired'`;

// The function never aborts the tracker update: on any failure it warns and
// the position-sync GET remains the recovery path.
const TRIGGER_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION cab_enqueue_trading_command() RETURNS trigger AS $$
DECLARE
  v_type text;
  v_reason text;
  v_stop numeric;
  v_old_stop numeric;
  v_last_stop numeric;
  v_seq integer;
  v_cid text;
  v_extra jsonb := '{}'::jsonb;
  v_fraction numeric := 1;
  v_partial boolean := false;
BEGIN
  BEGIN
    IF NEW.is_short OR NEW.signal_id IS NULL THEN RETURN NEW; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM trading_signal_deliveries d
      WHERE d.source_signal_id = NEW.signal_id
        AND d.status IN ('processing', 'delivered')
    ) THEN
      RETURN NEW;
    END IF;

    IF NEW.status IN ('active', 'in_run')
       AND OLD.status IN ('active', 'in_run')
       AND OLD.core_closed_at IS NULL AND NEW.core_closed_at IS NOT NULL THEN
      -- Partial exit: core part of an Impulse runner position. The fraction
      -- is of the INITIAL volume, never of the remaining one.
      v_type := 'close';
      v_partial := true;
      v_fraction := ${IMPULSE_RUNNER_CORE_WEIGHT};
      v_reason := 'core_exit';
      v_extra := jsonb_build_object(
        'closeFractionOfInitial', v_fraction,
        'partial', true,
        'remainingFractionOfInitial', 1 - v_fraction,
        'exitPrice', NEW.core_exit_price,
        'pnlPercent', NEW.core_pnl_percent
      );
    ELSIF NEW.status IN (${CLOSE_STATUSES_SQL})
       AND (OLD.status IN ('active', 'in_run')
            OR (OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL)) THEN
      v_type := 'close';
      v_reason := CASE
        WHEN NEW.status = 'stop_loss' THEN 'stop_loss'
        WHEN NEW.status = 'expired' THEN 'expired'
        WHEN NEW.status = 'bu_stop' THEN 'breakeven_stop'
        WHEN NEW.status = 'breakeven' THEN 'breakeven_close'
        WHEN NEW.trailing_stop_level IS NOT NULL
             AND NEW.exit_price IS NOT NULL
             AND NEW.exit_price <= NEW.trailing_stop_level * 1.0005
          THEN 'trailing_stop'
        ELSE 'profit'
      END;
      -- After a partial core exit only the runner remainder is left.
      IF OLD.core_closed_at IS NOT NULL THEN
        v_fraction := ${IMPULSE_RUNNER_RUNNER_WEIGHT};
      END IF;
      v_extra := jsonb_build_object(
        'closeFractionOfInitial', v_fraction,
        'partial', false,
        'trackerStatus', NEW.status,
        'exitPrice', NEW.exit_price,
        'pnlPercent', NEW.pnl_percent
      );
    ELSIF NEW.status IN ('cancelled', 'reclassified')
          AND OLD.status IN ('active', 'in_run') THEN
      v_type := 'cancel_entry';
      v_reason := COALESCE(NULLIF(NEW.cancel_reason, ''), NEW.status);
      v_extra := jsonb_build_object('trackerStatus', NEW.status);
    ELSIF NEW.status IN ('active', 'in_run')
          AND OLD.status IN ('active', 'in_run') THEN
      -- After the core exit the live stop belongs to the runner remainder.
      IF NEW.core_closed_at IS NOT NULL THEN
        v_stop := NEW.runner_trailing_stop_level::numeric;
        v_old_stop := OLD.runner_trailing_stop_level::numeric;
      ELSE
        v_stop := GREATEST(NEW.stop_loss_price, NEW.trailing_stop_level)::numeric;
        v_old_stop := GREATEST(OLD.stop_loss_price, OLD.trailing_stop_level)::numeric;
      END IF;
      IF v_stop IS NULL OR v_stop <= 0
         OR v_stop IS NOT DISTINCT FROM v_old_stop THEN
        RETURN NEW;
      END IF;
      SELECT stop_price INTO v_last_stop
      FROM trading_command_outbox
      WHERE tracked_signal_id = NEW.id AND type = 'move_stop'
      ORDER BY event_seq DESC LIMIT 1;
      IF v_last_stop IS NOT DISTINCT FROM v_stop THEN RETURN NEW; END IF;
      v_type := 'move_stop';
      v_reason := CASE
        WHEN NEW.core_closed_at IS NOT NULL THEN 'runner_trailing_stop_update'
        WHEN NEW.trailing_stop_level IS NOT NULL
             AND NEW.trailing_stop_level >= COALESCE(NEW.stop_loss_price, 0)
          THEN CASE WHEN NEW.trailing_stop_level >= NEW.entry_price
                 THEN 'trailing_or_breakeven_protection'
                 ELSE 'trailing_stop_update' END
        ELSE 'initial_stop_update'
      END;
    ELSE
      RETURN NEW;
    END IF;

    SELECT COALESCE(MAX(event_seq), 0) + 1 INTO v_seq
    FROM trading_command_outbox WHERE tracked_signal_id = NEW.id;
    v_cid := 'cab-cmd-' || NEW.id::text || '-' || v_seq::text;

    INSERT INTO trading_command_outbox (
      command_id, tracked_signal_id, source_signal_id, symbol, type,
      event_seq, event_at, reason, stop_price, close_fraction_of_initial,
      is_partial, payload
    ) VALUES (
      v_cid, NEW.id, 'cab-signal-' || NEW.signal_id::text,
      replace(upper(NEW.symbol), '-', ''), v_type, v_seq, now(), v_reason,
      CASE WHEN v_type = 'move_stop' THEN v_stop END,
      CASE WHEN v_type = 'close' THEN v_fraction END,
      v_partial,
      jsonb_build_object(
        'commandId', v_cid,
        'sourceSignalId', 'cab-signal-' || NEW.signal_id::text,
        'symbol', replace(upper(NEW.symbol), '-', ''),
        'type', v_type,
        'eventSeq', v_seq,
        'eventAt', to_char(now() AT TIME ZONE 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'reason', v_reason,
        'source', 'CryptoAltBullet'
      )
      || CASE WHEN v_type = 'move_stop'
           THEN jsonb_build_object('stopPrice', v_stop::text) ELSE '{}'::jsonb END
      || v_extra
    ) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'cab_enqueue_trading_command failed for tracked_signal %: %',
      NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
`;

const TRIGGER_NAME = "cab_trading_command_enqueue";
const CREATE_TRIGGER_SQL = `
CREATE TRIGGER ${TRIGGER_NAME}
AFTER UPDATE ON tracked_signals
FOR EACH ROW
WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  OR OLD.stop_loss_price IS DISTINCT FROM NEW.stop_loss_price
  OR OLD.trailing_stop_level IS DISTINCT FROM NEW.trailing_stop_level
  OR OLD.closed_at IS DISTINCT FROM NEW.closed_at
  OR OLD.core_closed_at IS DISTINCT FROM NEW.core_closed_at
  OR OLD.runner_trailing_stop_level IS DISTINCT FROM NEW.runner_trailing_stop_level
)
EXECUTE FUNCTION cab_enqueue_trading_command()
`;

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS trading_command_outbox (
  command_id text PRIMARY KEY,
  tracked_signal_id integer NOT NULL,
  source_signal_id text NOT NULL,
  symbol text NOT NULL,
  type text NOT NULL,
  event_seq integer NOT NULL,
  event_at timestamptz NOT NULL,
  reason text NOT NULL,
  stop_price numeric,
  close_fraction_of_initial numeric,
  is_partial boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token text,
  claim_until timestamptz,
  last_http_status integer,
  last_error text,
  accepted_at timestamptz,
  paper_status text,
  paper_at timestamptz,
  vst_status text,
  vst_at timestamptz,
  ack_detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
)`;

/**
 * The table is created at startup (like the project's other runtime tables),
 * not by the publish-time schema push. The trigger install is idempotent and
 * runs under an advisory lock.
 */
export async function ensureTradingCommandOutboxSchema(): Promise<void> {
  {
    await pool.query(CREATE_TABLE_SQL);
    await pool.query(
      "CREATE INDEX IF NOT EXISTS trading_command_outbox_due_idx ON trading_command_outbox (status, next_attempt_at)",
    );
    await pool.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS trading_command_outbox_seq_uq ON trading_command_outbox (tracked_signal_id, event_seq)",
    );
    await pool.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS trading_command_outbox_terminal_uq ON trading_command_outbox (tracked_signal_id) WHERE type IN ('close', 'cancel_entry') AND NOT is_partial",
    );
  }
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [TRIGGER_NAME]);
    await client.query(TRIGGER_FUNCTION_SQL);
    const exists = await client.query(
      "SELECT 1 FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal",
      [TRIGGER_NAME],
    );
    const def = await client.query<{ def: string }>(
      "SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal",
      [TRIGGER_NAME],
    );
    if (def.rows[0] && !def.rows[0].def.includes("core_closed_at")) {
      await client.query(`DROP TRIGGER ${TRIGGER_NAME} ON tracked_signals`);
      await client.query(CREATE_TRIGGER_SQL);
    } else if (!exists.rowCount) {
      await client.query(CREATE_TRIGGER_SQL);
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext($1))", [TRIGGER_NAME])
      .catch(() => undefined);
    client.release();
  }
}

type ClaimedCommand = {
  command_id: string;
  payload: Record<string, unknown>;
  claim_token: string;
  attempts: number;
};

async function supersedeStaleStops(): Promise<void> {
  // A newer command for the same position makes an unsent older stop level
  // obsolete; sending it late could only move the stop backwards.
  await pool.query(`
    UPDATE trading_command_outbox c
    SET status = 'superseded', last_error = 'newer_command_exists'
    WHERE c.type = 'move_stop' AND c.status = 'pending'
      AND EXISTS (
        SELECT 1 FROM trading_command_outbox n
        WHERE n.tracked_signal_id = c.tracked_signal_id
          AND n.event_seq > c.event_seq
      )
  `);
}

async function claimNextCommand(): Promise<ClaimedCommand | null> {
  const claimToken = randomUUID();
  const result = await pool.query<ClaimedCommand>(
    `
    UPDATE trading_command_outbox
    SET status = 'processing', claim_token = $1,
        claim_until = now() + make_interval(secs => $2),
        attempts = attempts + 1
    WHERE command_id = (
      SELECT c.command_id FROM trading_command_outbox c
      WHERE ((c.status = 'pending' AND c.next_attempt_at <= now())
             OR (c.status = 'processing' AND c.claim_until < now()))
        AND NOT EXISTS (
          SELECT 1 FROM trading_command_outbox p
          WHERE p.tracked_signal_id = c.tracked_signal_id
            AND p.event_seq < c.event_seq
            AND p.status IN ('pending', 'processing')
        )
      ORDER BY c.created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING command_id, payload, claim_token, attempts
    `,
    [claimToken, CLAIM_LEASE_SECONDS],
  );
  return result.rows[0] ?? null;
}

async function finishCommand(
  claim: ClaimedCommand,
  outcome: CommandReceiptOutcome,
  status: number | null,
  error: string | null,
): Promise<void> {
  const result = await pool.query(
    `
    UPDATE trading_command_outbox
    SET status = CASE WHEN $3 = 'retry' THEN 'pending'
                      WHEN $3 = 'accepted' THEN 'accepted'
                      ELSE 'quarantined' END,
        next_attempt_at = CASE WHEN $3 = 'retry'
          THEN now() + make_interval(secs => $6) ELSE next_attempt_at END,
        accepted_at = CASE WHEN $3 = 'accepted' THEN now() ELSE accepted_at END,
        claim_token = NULL, claim_until = NULL,
        last_http_status = $4, last_error = $5
    WHERE command_id = $1 AND status = 'processing' AND claim_token = $2
    `,
    [
      claim.command_id,
      claim.claim_token,
      outcome,
      status,
      error,
      commandBackoffMs(claim.attempts) / 1000,
    ],
  );
  if (result.rowCount !== 1) {
    logger.warn(
      { commandId: claim.command_id },
      "Trading command claim changed before acknowledgement",
    );
  }
}

async function sendClaimedCommand(
  claim: ClaimedCommand,
  token: string,
): Promise<void> {
  try {
    const response = await fetch(TRADING_COMMAND_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-trading-token": token,
        "Idempotency-Key": claim.command_id,
      },
      body: JSON.stringify(claim.payload),
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
    });
    const body = await response.json().catch(() => null);
    const outcome = classifyCommandReceipt(
      response.status,
      body,
      claim.command_id,
    );
    await finishCommand(
      claim,
      outcome,
      response.status,
      outcome === "accepted" ? null : `receiver_http_${response.status}`,
    );
    if (outcome === "accepted") {
      logger.info(
        { commandId: claim.command_id, type: claim.payload.type },
        "Trading command stored by receiver",
      );
    } else {
      logger.warn(
        { commandId: claim.command_id, status: response.status, outcome },
        "Trading command not stored by receiver",
      );
    }
  } catch (error) {
    await finishCommand(
      claim,
      "retry",
      null,
      error instanceof Error ? error.name : "network_error",
    );
    logger.warn(
      { commandId: claim.command_id, err: error },
      "Trading command request failed",
    );
  }
}

let running = false;
async function commandTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const token = process.env.TRADING_INGEST_TOKEN;
    if (!token) return;
    await supersedeStaleStops();
    for (let i = 0; i < 10; i++) {
      const claim = await claimNextCommand();
      if (!claim) break;
      await sendClaimedCommand(claim, token);
    }
  } catch (error) {
    logger.error({ err: error }, "Trading command cycle failed");
  } finally {
    running = false;
  }
}

export function startTradingCommandRelay(): void {
  if (process.env.NODE_ENV !== "production") return;
  setTimeout(() => void commandTick(), 20_000);
  setInterval(() => void commandTick(), COMMAND_INTERVAL_MS);
  logger.info(
    { receiver: TRADING_COMMAND_ENDPOINT },
    "Trading command relay scheduled",
  );
}

export type CommandAckInput = {
  commandId: string;
  environment: "paper" | "vst";
  status:
    | "executed"
    | "already_closed"
    | "rejected"
    | "failed"
    | "stale_ignored";
  detail?: unknown;
};

export const COMMAND_ACK_STATUSES = [
  "executed",
  "already_closed",
  "rejected",
  "failed",
  "stale_ignored",
] as const;

/** Records an execution confirmation for one environment. Returns false when
 * the command does not exist. An ack also proves the receiver stored it. */
export async function recordCommandAck(
  input: CommandAckInput,
): Promise<boolean> {
  const col = input.environment === "paper" ? "paper" : "vst";
  const result = await pool.query(
    `
    UPDATE trading_command_outbox
    SET ${col}_status = $2, ${col}_at = now(),
        ack_detail = COALESCE(ack_detail, '{}'::jsonb) ||
                     jsonb_build_object($3::text, $4::jsonb),
        status = CASE WHEN status IN ('pending', 'processing')
                      THEN 'accepted' ELSE status END,
        accepted_at = COALESCE(accepted_at, now()),
        claim_token = CASE WHEN status IN ('pending', 'processing')
                           THEN NULL ELSE claim_token END
    WHERE command_id = $1
    `,
    [
      input.commandId,
      input.status,
      input.environment,
      JSON.stringify(input.detail ?? null),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}
