import express, { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireAdminToken } from "../middleware/adminAuth.js";
import { isTradingBotToken } from "./trading-position-sync.js";
import {
  COMMAND_ACK_STATUSES,
  recordCommandAck,
  type CommandAckInput,
} from "../lib/trading-command-outbox.js";

/** Machine route for the trading bot: execution confirmations per environment. */
export const tradingCommandAcksRouter: IRouter = Router();
tradingCommandAcksRouter.post(
  "/",
  express.json({ limit: "32kb" }),
  async (req, res): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    const expected = process.env.TRADING_INGEST_TOKEN;
    if (!expected) {
      res.status(503).json({ error: "trading_bot_access_not_configured" });
      return;
    }
    if (!isTradingBotToken(req.get("x-trading-token"), expected)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const b = req.body as Record<string, unknown> | null;
    const environment = b?.environment;
    const status = b?.status;
    if (
      !b ||
      typeof b.commandId !== "string" ||
      b.commandId.length === 0 ||
      b.commandId.length > 100 ||
      (environment !== "paper" && environment !== "vst") ||
      typeof status !== "string" ||
      !(COMMAND_ACK_STATUSES as readonly string[]).includes(status)
    ) {
      res.status(400).json({ error: "invalid_ack" });
      return;
    }
    try {
      const found = await recordCommandAck({
        commandId: b.commandId,
        environment,
        status: status as CommandAckInput["status"],
        detail: b.detail,
      });
      if (!found) {
        res.status(404).json({ error: "unknown_command" });
        return;
      }
      res.json({ ok: true, commandId: b.commandId, environment, status });
    } catch (error) {
      req.log?.error({ err: error }, "Trading command ack failed");
      res.status(503).json({ error: "ack_unavailable" });
    }
  },
);

/** Owner view: commands that are not yet stored or not yet executed. */
const ownerRouter: IRouter = Router();
ownerRouter.get(
  "/trading/commands",
  requireAdminToken,
  async (_req, res): Promise<void> => {
    try {
      const rows = await pool.query(`
        SELECT command_id AS "commandId", source_signal_id AS "sourceSignalId",
               symbol, type, event_seq AS "eventSeq", reason,
               stop_price AS "stopPrice", status, attempts,
               last_http_status AS "lastHttpStatus", last_error AS "lastError",
               created_at AS "createdAt", accepted_at AS "acceptedAt",
               paper_status AS "paperStatus", paper_at AS "paperAt",
               vst_status AS "vstStatus", vst_at AS "vstAt"
        FROM trading_command_outbox
        WHERE status IN ('pending', 'processing', 'quarantined')
           OR (status = 'accepted'
               AND (paper_status IS NULL OR vst_status IS NULL)
               AND created_at > now() - interval '7 days')
        ORDER BY created_at DESC LIMIT 200
      `);
      const counts = await pool.query(`
        SELECT status, count(*)::int AS n
        FROM trading_command_outbox GROUP BY status
      `);
      res.json({ commands: rows.rows, counts: counts.rows });
    } catch {
      res.status(503).json({ error: "commands_unavailable" });
    }
  },
);

export default ownerRouter;
