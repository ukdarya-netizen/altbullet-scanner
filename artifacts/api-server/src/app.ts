import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireDashboardAccess } from "./middleware/dashboardAccess.js";
import tradingPositionSyncRouter from "./routes/trading-position-sync.js";
import { tradingCommandAcksRouter } from "./routes/trading-commands.js";

const app: Express = express();

// Disable ETag — prevents 304 Not Modified caching of API responses in the dashboard
app.set("etag", false);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// The receiver has no dashboard session. Keep this narrowly authenticated
// machine route ahead of the browser CORS and dashboard middleware.
app.use("/api/trading/position-sync", tradingPositionSyncRouter);
app.use("/api/trading/command-acks", tradingCommandAcksRouter);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Force no-cache on all API responses so the dashboard always gets fresh data
app.use("/api", (_, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.use("/api", requireDashboardAccess);
app.use("/api", router);

export default app;
