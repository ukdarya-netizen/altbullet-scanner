import { createHash, timingSafeEqual } from "node:crypto";
import { effectiveSourceUpdatedAt } from "../lib/tracker-heartbeat.js";
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { GetTradingPositionSyncResponse } from "@workspace/api-zod";

const PAGE_SIZE = 200;

export function isTradingBotToken(
  supplied: string | undefined,
  expected: string | undefined,
): boolean {
  if (!supplied || !expected) return false;
  const actualHash = createHash("sha256").update(supplied).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export type TradingSourceAction = "hold" | "close" | "review" | "unknown";

const CLOSE_STATUSES = new Set([
  "profit",
  "stop_loss",
  "bu_stop",
  "breakeven",
  "expired",
]);

/**
 * Explicit instruction for the receiver. "close" only for real tracker closes
 * (a close time exists). Cancelled/reclassified rows are dashboard
 * administration, not exits: the receiver must review them against the exchange.
 */
export function deriveTradingSourceAction(
  status: string | null,
  closedAt: Date | null,
): TradingSourceAction {
  if (status === null) return "unknown";
  if (status === "active" || status === "in_run") return "hold";
  if (CLOSE_STATUSES.has(status) && closedAt !== null) return "close";
  return "review";
}

type SourcePosition = {
  id: number;
  signalAt: Date;
  botEnqueuedAt: Date | null;
  symbol: string | null;
  initialStopPrice: string | null;
  sourceStatus: string | null;
  sourceUpdatedAt: Date | null;
  sourceClosedAt: Date | null;
  sourceEntryPrice: number | null;
  sourceExitPrice: number | null;
  sourcePnlPercent: number | null;
  sourcePeakPrice: number | null;
  sourceStopLossPrice: number | null;
  sourceTrailingStopLevel: number | null;
  sourceLastMilestone: number | null;
  sourceCancelReason: string | null;
};

export async function readTradingPositionSync(afterId: number): Promise<{
  asOf: string;
  positions: Array<{
    sourceSignalId: string;
    signalAt: string;
    botEnqueuedAt: string | null;
    symbol: string | null;
    initialStopPrice: string | null;
    sourceStatus: string | null;
    sourceAction: TradingSourceAction;
    sourceUpdatedAt: string | null;
    sourceClosedAt: string | null;
    sourceEntryPrice: number | null;
    sourceExitPrice: number | null;
    sourcePnlPercent: number | null;
    sourcePeakPrice: number | null;
    sourceStopLossPrice: number | null;
    sourceTrailingStopLevel: number | null;
    sourceLastMilestone: number | null;
    sourceCancelReason: string | null;
  }>;
  nextAfterId: number | null;
}> {
  const result = await pool.query<SourcePosition>(
    `SELECT d.source_signal_id AS id, d.signal_at AS "signalAt",
            d.delivered_at AS "botEnqueuedAt",
            d.payload ->> 'symbol' AS symbol,
            d.payload ->> 'stopLoss' AS "initialStopPrice",
            t.status AS "sourceStatus", t.updated_at AS "sourceUpdatedAt",
            t.closed_at AS "sourceClosedAt",
            t.entry_price AS "sourceEntryPrice", t.exit_price AS "sourceExitPrice",
            t.pnl_percent AS "sourcePnlPercent", t.peak_price AS "sourcePeakPrice",
            t.stop_loss_price AS "sourceStopLossPrice",
            t.trailing_stop_level AS "sourceTrailingStopLevel",
            t.last_milestone AS "sourceLastMilestone",
            t.cancel_reason AS "sourceCancelReason"
     FROM trading_signal_deliveries d
     LEFT JOIN LATERAL (
       SELECT status, updated_at, closed_at, entry_price, exit_price,
              pnl_percent, peak_price, stop_loss_price, trailing_stop_level,
              last_milestone, cancel_reason
       FROM tracked_signals
       WHERE signal_id = d.source_signal_id
       ORDER BY id DESC LIMIT 1
     ) t ON true
     WHERE d.status = 'delivered' AND d.source_signal_id > $1
     ORDER BY d.source_signal_id ASC LIMIT $2`,
    [afterId, PAGE_SIZE + 1],
  );
  const hasMore = result.rows.length > PAGE_SIZE;
  const page = result.rows.slice(0, PAGE_SIZE);
  return {
    asOf: new Date().toISOString(),
    positions: page.map(
      ({
        id,
        signalAt,
        botEnqueuedAt,
        sourceUpdatedAt,
        sourceClosedAt,
        ...rest
      }) => ({
        sourceAction: deriveTradingSourceAction(
          rest.sourceStatus,
          sourceClosedAt,
        ),
        sourceSignalId: `cab-signal-${id}`,
        signalAt: signalAt.toISOString(),
        botEnqueuedAt: botEnqueuedAt?.toISOString() ?? null,
        sourceUpdatedAt:
          effectiveSourceUpdatedAt(
            sourceUpdatedAt,
            id,
            rest.sourceStatus === "active" || rest.sourceStatus === "in_run",
          )?.toISOString() ?? null,
        sourceClosedAt: sourceClosedAt?.toISOString() ?? null,
        ...rest,
      }),
    ),
    nextAfterId: hasMore ? page[page.length - 1]!.id : null,
  };
}

export function createTradingPositionSyncRouter({
  token = () => process.env.TRADING_INGEST_TOKEN,
  read = readTradingPositionSync,
}: {
  token?: () => string | undefined;
  read?: typeof readTradingPositionSync;
} = {}): IRouter {
  const router: IRouter = Router();
  router.get("/", async (req, res): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    const expectedToken = token();
    if (!expectedToken) {
      res.status(503).json({ error: "trading_bot_access_not_configured" });
      return;
    }
    if (!isTradingBotToken(req.get("x-trading-token"), expectedToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const rawAfterId = req.query.afterId;
    if (
      rawAfterId !== undefined &&
      (typeof rawAfterId !== "string" ||
        !/^(0|[1-9]\d{0,9})$/.test(rawAfterId) ||
        Number(rawAfterId) > 2147483647)
    ) {
      res.status(400).json({ error: "invalid_after_id" });
      return;
    }
    try {
      const body = GetTradingPositionSyncResponse.parse(
        await read(rawAfterId === undefined ? 0 : Number(rawAfterId)),
      );
      req.log?.info(
        {
          afterId: rawAfterId ?? null,
          positions: body.positions.length,
          closeActions: body.positions.filter((p) => p.sourceAction === "close")
            .length,
        },
        "Trading bot position sync polled",
      );
      res.json(body);
    } catch (error) {
      req.log?.error({ err: error }, "Trading bot position sync failed");
      res.status(503).json({ error: "position_sync_unavailable" });
    }
  });
  return router;
}

export default createTradingPositionSyncRouter();
