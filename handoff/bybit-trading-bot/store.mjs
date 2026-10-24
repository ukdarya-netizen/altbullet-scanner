import { createHash } from "node:crypto";

const ADVISORY_LOCK_NAMESPACE = 4_348_994;
const ADVISORY_LOCK_ID = 1;

const SIGNAL_STATUSES = new Set([
  "pending",
  "opening",
  "open",
  "closed",
  "rejected",
  "quarantined",
  "error",
]);
const POSITION_STATUSES = new Set(["open", "closing", "closed", "error"]);
const SECRET_KEY = /(api[_-]?key|secret|password|token|authorization|credential)/i;
const MAX_REASON_LENGTH = 2_000;

/**
 * Convert JSON-compatible input to a deterministic JSON value.
 * Sorted object keys ensure semantically identical signal retries hash equally.
 */
function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Signal values must contain only finite numbers");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("Signal values must be JSON-compatible");
  }
  if (seen.has(value)) {
    throw new TypeError("Signal values must not contain circular references");
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, seen));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Signal objects must be plain JSON objects");
    }

    const output = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) {
        throw new TypeError("Signal objects must not contain undefined values");
      }
      output[key] = canonicalize(child, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function assertNoCredentials(value, path = "value") {
  if (value === null || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      throw new TypeError(`Credentials are not allowed in persisted ${path}`);
    }
    assertNoCredentials(child, `${path}.${key}`);
  }
}

function serializeJson(value, label) {
  assertNoCredentials(value, label);
  return JSON.stringify(canonicalize(value));
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function validateStatus(status, validStatuses, name) {
  if (!validStatuses.has(status)) {
    throw new TypeError(`Unsupported ${name}: ${String(status)}`);
  }
}

function toRow(row) {
  if (!row) return null;
  return {
    sourceSignalId: row.source_signal_id,
    body: row.body,
    bodyHash: row.body_hash,
    status: row.status,
    reason: row.reason,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  };
}

function paperAccountFromRow(row) {
  if (!row) return null;
  return {
    initialUsdt: Number(row.initial_usdt),
    freeUsdt: Number(row.free_usdt),
    reservedUsdt: Number(row.reserved_usdt),
    realizedPnlUsdt: Number(row.realized_pnl_usdt),
  };
}

function finiteUsdt(value, name) {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) {
    throw new TypeError(`${name} must be a finite USDT amount`);
  }
  return amount;
}

function positionFromRow(row) {
  if (!row) return null;
  return {
    sourceSignalId: row.source_signal_id,
    snapshot: row.snapshot,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

export function hashSignal(signal) {
  const canonicalJson = serializeJson(signal, "signal");
  return createHash("sha256").update(canonicalJson).digest("hex");
}

/**
 * Create accessors for the separately provisioned btb_* tables.
 * Schema installation is intentionally a manual deployment/migration step.
 */
export function createStore(pool) {
  if (
    !pool ||
    typeof pool.query !== "function" ||
    typeof pool.connect !== "function"
  ) {
    throw new TypeError("createStore requires a PostgreSQL pool");
  }

  return {
    /**
     * Persist the event before acknowledging it. A duplicate with the same ID
     * and canonical body is safe to acknowledge; reuse of an ID with changed
     * content is returned as a conflict and must not create another trade.
     */
    async enqueue(signal) {
      const sourceSignalId = requireNonEmptyString(
        signal?.sourceSignalId,
        "sourceSignalId",
      );
      const body = serializeJson(signal, "signal");
      const bodyHash = createHash("sha256").update(body).digest("hex");
      const inserted = await pool.query(
        `
          INSERT INTO btb_signals
            (source_signal_id, body, body_hash, status)
          VALUES ($1, $2::jsonb, $3, 'pending')
          ON CONFLICT (source_signal_id) DO NOTHING
          RETURNING source_signal_id, status
        `,
        [sourceSignalId, body, bodyHash],
      );
      if (inserted.rowCount > 0) {
        return {
          kind: "new",
          status: inserted.rows[0].status,
        };
      }

      // ON CONFLICT waits for a concurrent insert to commit before this read.
      const existing = await pool.query(
        `
          SELECT body_hash, status
          FROM btb_signals
          WHERE source_signal_id = $1
        `,
        [sourceSignalId],
      );
      if (existing.rowCount === 0) {
        throw new Error("Signal insert conflict could not be resolved");
      }

      const row = existing.rows[0];
      return {
        kind: row.body_hash === bodyHash ? "duplicate" : "conflict",
        status: row.status,
      };
    },

    /**
     * Serialize worker activity across replicas. Advisory locks are held on a
     * dedicated session for the whole callback and explicitly released even
     * when the callback fails.
     */
    async withLeaderLock(callback) {
      if (typeof callback !== "function") {
        throw new TypeError("withLeaderLock requires a callback");
      }
      const client = await pool.connect();
      let lockAcquired = false;
      let destroyClient = false;
      try {
        const result = await client.query(
          "SELECT pg_try_advisory_lock($1, $2) AS acquired",
          [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_ID],
        );
        lockAcquired = result.rows[0]?.acquired === true;
        if (!lockAcquired) return null;
        return await callback();
      } finally {
        if (lockAcquired) {
          try {
            const unlocked = await client.query(
              "SELECT pg_advisory_unlock($1, $2) AS released",
              [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_ID],
            );
            if (unlocked.rows[0]?.released !== true) destroyClient = true;
          } catch {
            // Returning a session with a possibly held session lock to the pool
            // could permanently block the worker; destroy it instead.
            destroyClient = true;
          }
        }
        client.release(destroyClient);
      }
    },

    /**
     * Must be called by the leader-locked worker. "opening" rows are surfaced
     * first so an exchange submission with an uncertain response can be
     * reconciled using its deterministic order link ID, not blindly retried.
     */
    async getPending(now = Date.now()) {
      const timestamp = now instanceof Date ? now.getTime() : Number(now);
      if (!Number.isFinite(timestamp)) {
        throw new TypeError("now must be a valid timestamp");
      }
      const result = await pool.query(
        `
          SELECT source_signal_id, body, body_hash, status, reason,
                 received_at, updated_at
          FROM btb_signals
          WHERE status IN ('opening', 'pending')
          ORDER BY CASE WHEN status = 'opening' THEN 0 ELSE 1 END,
                   received_at ASC, source_signal_id ASC
          LIMIT 1
        `,
      );
      return toRow(result.rows[0]);
    },

    async setSignalStatus(sourceSignalId, status, reason = null) {
      requireNonEmptyString(sourceSignalId, "sourceSignalId");
      validateStatus(status, SIGNAL_STATUSES, "signal status");
      if (reason !== null && typeof reason !== "string") {
        throw new TypeError("reason must be a string or null");
      }
      if (reason !== null && reason.length > MAX_REASON_LENGTH) {
        throw new RangeError(`reason must be at most ${MAX_REASON_LENGTH} characters`);
      }

      const result = await pool.query(
        `
          UPDATE btb_signals
          SET status = $2, reason = $3, updated_at = now()
          WHERE source_signal_id = $1
          RETURNING source_signal_id, body, body_hash, status, reason,
                    received_at, updated_at
        `,
        [sourceSignalId, status, reason],
      );
      return toRow(result.rows[0]);
    },

    async upsertPosition(position) {
      const sourceSignalId = requireNonEmptyString(
        position?.sourceSignalId,
        "position.sourceSignalId",
      );
      validateStatus(position.status, POSITION_STATUSES, "position status");
      const snapshot = serializeJson(position, "position");
      const result = await pool.query(
        `
          INSERT INTO btb_positions
            (source_signal_id, snapshot, status)
          VALUES ($1, $2::jsonb, $3)
          ON CONFLICT (source_signal_id)
          DO UPDATE SET
            snapshot = EXCLUDED.snapshot,
            status = EXCLUDED.status,
            updated_at = now()
          RETURNING source_signal_id, snapshot, status, updated_at
        `,
        [sourceSignalId, snapshot, position.status],
      );
      return {
        sourceSignalId: result.rows[0].source_signal_id,
        snapshot: result.rows[0].snapshot,
        status: result.rows[0].status,
        updatedAt: result.rows[0].updated_at,
      };
    },

    async listOpenPositions() {
      const result = await pool.query(
        `
          SELECT source_signal_id, snapshot, status, updated_at
          FROM btb_positions
          WHERE status IN ('open', 'closing')
          ORDER BY updated_at ASC, source_signal_id ASC
        `,
      );
      return result.rows.map((row) => ({
        sourceSignalId: row.source_signal_id,
        snapshot: row.snapshot,
        status: row.status,
        updatedAt: row.updated_at,
      }));
    },

    async updatePosition(sourceSignalId, patch) {
      requireNonEmptyString(sourceSignalId, "sourceSignalId");
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new TypeError("patch must be a JSON object");
      }
      const serializedPatch = serializeJson(patch, "position patch");
      const status =
        patch.status === undefined ? null : patch.status;
      if (status !== null) {
        validateStatus(status, POSITION_STATUSES, "position status");
      }

      const result = await pool.query(
        `
          UPDATE btb_positions
          SET snapshot = snapshot || $2::jsonb,
              status = COALESCE($3, status),
              updated_at = now()
          WHERE source_signal_id = $1
          RETURNING source_signal_id, snapshot, status, updated_at
        `,
        [sourceSignalId, serializedPatch, status],
      );
      if (result.rowCount === 0) return null;
      return {
        sourceSignalId: result.rows[0].source_signal_id,
        snapshot: result.rows[0].snapshot,
        status: result.rows[0].status,
        updatedAt: result.rows[0].updated_at,
      };
    },

    async getPaperAccount() {
      const result = await pool.query(
        `
          SELECT initial_usdt, free_usdt, reserved_usdt, realized_pnl_usdt
          FROM btb_paper_account
          WHERE singleton = true
        `,
      );
      if (result.rowCount === 0) {
        throw new Error("Paper account is not initialized; apply schema.sql first");
      }
      return paperAccountFromRow(result.rows[0]);
    },

    /**
     * Reserve the fixed 10 USDT paper margin and create the position in one
     * transaction. Duplicate IDs never debit the wallet a second time.
     */
    async openPaperPosition(position) {
      const sourceSignalId = requireNonEmptyString(
        position?.sourceSignalId,
        "position.sourceSignalId",
      );
      validateStatus(position.status, POSITION_STATUSES, "position status");
      if (position.status !== "open") {
        throw new TypeError("A new paper position must have status 'open'");
      }
      const realizedPnlUsdt = finiteUsdt(
        position.realizedPnlUsdt ?? 0,
        "position.realizedPnlUsdt",
      );
      const snapshot = {
        ...position,
        realizedPnlUsdt,
        marginHeldUsd: 10,
      };
      const serializedSnapshot = serializeJson(snapshot, "paper position");
      const client = await pool.connect();
      let transactionOpen = false;

      try {
        await client.query("BEGIN");
        transactionOpen = true;

        const existing = await client.query(
          `
            SELECT source_signal_id
            FROM btb_positions
            WHERE source_signal_id = $1
            FOR UPDATE
          `,
          [sourceSignalId],
        );
        if (existing.rowCount > 0) {
          await client.query("COMMIT");
          transactionOpen = false;
          return { kind: "duplicate" };
        }

        const account = await client.query(
          `
            UPDATE btb_paper_account
            SET free_usdt = free_usdt - 10,
                reserved_usdt = reserved_usdt + 10
            WHERE singleton = true AND free_usdt >= 10
            RETURNING singleton
          `,
        );
        if (account.rowCount === 0) {
          const initialized = await client.query(
            "SELECT singleton FROM btb_paper_account WHERE singleton = true",
          );
          await client.query("ROLLBACK");
          transactionOpen = false;
          if (initialized.rowCount === 0) {
            throw new Error(
              "Paper account is not initialized; apply schema.sql first",
            );
          }

          // A concurrent opener for this same ID may have committed while the
          // conditional wallet update waited on the singleton account row.
          const racedDuplicate = await pool.query(
            `
              SELECT source_signal_id
              FROM btb_positions
              WHERE source_signal_id = $1
            `,
            [sourceSignalId],
          );
          return racedDuplicate.rowCount > 0
            ? { kind: "duplicate" }
            : { kind: "insufficient" };
        }

        const inserted = await client.query(
          `
            INSERT INTO btb_positions
              (source_signal_id, snapshot, status)
            VALUES ($1, $2::jsonb, 'open')
            ON CONFLICT (source_signal_id) DO NOTHING
            RETURNING source_signal_id
          `,
          [sourceSignalId, serializedSnapshot],
        );
        if (inserted.rowCount === 0) {
          // Concurrent insert: roll back the reservation before reporting it.
          await client.query("ROLLBACK");
          transactionOpen = false;
          return { kind: "duplicate" };
        }

        await client.query("COMMIT");
        transactionOpen = false;
        return { kind: "opened" };
      } catch (error) {
        if (transactionOpen) {
          await client.query("ROLLBACK").catch(() => {});
        }
        throw error;
      } finally {
        client.release();
      }
    },

    /**
     * Apply the position's realized-PnL and released-margin deltas exactly
     * once. A retry based on an older snapshot is returned as stale without
     * changing either the wallet or the journal row.
     */
    async settlePaperPosition(previous, next) {
      const sourceSignalId = requireNonEmptyString(
        previous?.sourceSignalId,
        "previous.sourceSignalId",
      );
      if (next?.sourceSignalId !== sourceSignalId) {
        throw new TypeError("previous and next must identify the same position");
      }
      const previousRealized = finiteUsdt(
        previous.realizedPnlUsdt,
        "previous.realizedPnlUsdt",
      );
      const previousMargin = finiteUsdt(
        previous.marginHeldUsd,
        "previous.marginHeldUsd",
      );
      const nextRealized = finiteUsdt(
        next.realizedPnlUsdt,
        "next.realizedPnlUsdt",
      );
      const nextMargin = finiteUsdt(next.marginHeldUsd, "next.marginHeldUsd");
      validateStatus(previous.status, POSITION_STATUSES, "previous position status");
      validateStatus(next.status, POSITION_STATUSES, "next position status");
      if (previousMargin < 0 || nextMargin < 0) {
        throw new RangeError("Paper position margin cannot be negative");
      }
      const deltaRealized = nextRealized - previousRealized;
      const deltaMargin = previousMargin - nextMargin;
      if (deltaMargin < 0) {
        throw new RangeError("settlePaperPosition cannot increase held margin");
      }
      const serializedNext = serializeJson(next, "paper position");
      const client = await pool.connect();
      let transactionOpen = false;

      try {
        await client.query("BEGIN");
        transactionOpen = true;
        const currentResult = await client.query(
          `
            SELECT snapshot, status
            FROM btb_positions
            WHERE source_signal_id = $1
            FOR UPDATE
          `,
          [sourceSignalId],
        );
        if (currentResult.rowCount === 0) {
          await client.query("ROLLBACK");
          transactionOpen = false;
          return { kind: "stale" };
        }

        const current = currentResult.rows[0];
        const currentSnapshot =
          typeof current.snapshot === "string"
            ? JSON.parse(current.snapshot)
            : current.snapshot;
        const fieldsMatch =
          finiteUsdt(
            currentSnapshot.realizedPnlUsdt,
            "stored.realizedPnlUsdt",
          ) === previousRealized &&
          finiteUsdt(currentSnapshot.marginHeldUsd, "stored.marginHeldUsd") ===
            previousMargin &&
          current.status === previous.status &&
          currentSnapshot.status === previous.status;
        if (!fieldsMatch) {
          await client.query("ROLLBACK");
          transactionOpen = false;
          return { kind: "stale" };
        }

        const account = await client.query(
          `
            UPDATE btb_paper_account
            SET free_usdt = free_usdt + $1 + $2,
                reserved_usdt = reserved_usdt - $2,
                realized_pnl_usdt = realized_pnl_usdt + $1
            WHERE singleton = true AND reserved_usdt >= $2
            RETURNING initial_usdt, free_usdt, reserved_usdt, realized_pnl_usdt
          `,
          [deltaRealized, deltaMargin],
        );
        if (account.rowCount === 0) {
          const initialized = await client.query(
            "SELECT singleton FROM btb_paper_account WHERE singleton = true",
          );
          if (initialized.rowCount === 0) {
            throw new Error(
              "Paper account is not initialized; apply schema.sql first",
            );
          }
          throw new Error(
            "Paper wallet reserved margin is below the position margin release",
          );
        }

        await client.query(
          `
            UPDATE btb_positions
            SET snapshot = $2::jsonb, status = $3, updated_at = now()
            WHERE source_signal_id = $1
          `,
          [sourceSignalId, serializedNext, next.status],
        );

        await client.query("COMMIT");
        transactionOpen = false;
        return {
          kind: "settled",
          position: next,
          account: paperAccountFromRow(account.rows[0]),
        };
      } catch (error) {
        if (transactionOpen) {
          await client.query("ROLLBACK").catch(() => {});
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async listRecentPositions(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new RangeError("limit must be an integer between 1 and 500");
      }
      const result = await pool.query(
        `
          SELECT source_signal_id, snapshot, status, updated_at
          FROM btb_positions
          WHERE status IN ('open', 'closing', 'closed')
          ORDER BY updated_at DESC, source_signal_id DESC
          LIMIT $1
        `,
        [limit],
      );
      return result.rows.map(positionFromRow);
    },

    async recordEvent(sourceSignalId, kind, detail = {}) {
      if (sourceSignalId !== null) {
        requireNonEmptyString(sourceSignalId, "sourceSignalId");
      }
      requireNonEmptyString(kind, "kind");
      const serializedDetail = serializeJson(detail, "event detail");
      const result = await pool.query(
        `
          INSERT INTO btb_events (source_signal_id, kind, detail)
          VALUES ($1, $2, $3::jsonb)
          RETURNING id, source_signal_id, kind, detail, created_at
        `,
        [sourceSignalId, kind, serializedDetail],
      );
      const row = result.rows[0];
      return {
        id: row.id,
        sourceSignalId: row.source_signal_id,
        kind: row.kind,
        detail: row.detail,
        createdAt: row.created_at,
      };
    },

    async findSignal(sourceSignalId) {
      requireNonEmptyString(sourceSignalId, "sourceSignalId");
      const result = await pool.query(
        `
          SELECT source_signal_id, body, body_hash, status, reason,
                 received_at, updated_at
          FROM btb_signals
          WHERE source_signal_id = $1
        `,
        [sourceSignalId],
      );
      return toRow(result.rows[0]);
    },

    async listRecent(limit = 50) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new RangeError("limit must be an integer between 1 and 200");
      }
      const result = await pool.query(
        `
          SELECT source_signal_id, body, body_hash, status, reason,
                 received_at, updated_at
          FROM btb_signals
          ORDER BY received_at DESC, source_signal_id DESC
          LIMIT $1
        `,
        [limit],
      );
      return result.rows.map(toRow);
    },
  };
}