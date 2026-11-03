// Strategy report for the trading bot (owner 2026-11-03): machine route, same token as the position sync.
import { Router, type IRouter } from "express";
import { isTradingBotToken } from "./trading-position-sync.js";
import { readStrategyReport } from "../lib/trading-strategy-report.js";

const router: IRouter = Router();
router.get("/", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const expected = process.env.TRADING_INGEST_TOKEN;
  if (!expected) { res.status(503).json({ error: "trading_bot_access_not_configured" }); return; }
  if (!isTradingBotToken(req.get("x-trading-token"), expected)) { res.status(401).json({ error: "unauthorized" }); return; }
  const raw = Number(req.query.days);
  const days = Number.isInteger(raw) && raw > 0 && raw <= 3650 ? raw : null;
  try {
    res.json(await readStrategyReport(days));
  } catch (error) {
    req.log?.error({ err: error }, "Trading strategy report failed");
    res.status(503).json({ error: "strategy_report_unavailable" });
  }
});
export default router;
