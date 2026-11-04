import http from "node:http";
import { createBybit } from "./bybit.mjs";
import { authorized, validateSignal } from "./contract.mjs";
import { createStore } from "./store.mjs";
import { createWorker } from "./worker.mjs";

const MAX_BODY_BYTES = 32 * 1024;

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function parseBody(req) {
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request_too_large");
      error.status = 413;
      throw error;
    }
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    const error = new Error("invalid_json");
    error.status = 400;
    throw error;
  }
}

/** HTTP ingress only. Never places an order from the request handler. */
export function createServer({ store, token, mode = "paper", clock = Date.now }) {
  if (!token) throw new Error("TRADING_INGEST_TOKEN is required");
  if (mode !== "paper") throw new Error("PAPER_ONLY_SIGNAL: live mode is disabled");
  return http.createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://localhost").pathname;
    if (path === "/healthz" && req.method === "GET") {
      json(res, 200, { ok: true, mode: "paper" });
      return;
    }
    if (!authorized(req.headers["x-trading-token"], token)) {
      json(res, 401, { accepted: false, error: { code: "unauthorized" } });
      return;
    }
    if (path === "/api/trading/status" && req.method === "GET") {
      try {
        const [recent, positions, paperAccount] = await Promise.all([
          store.listRecent(50),
          store.listRecentPositions(100),
          store.getPaperAccount(),
        ]);
        json(res, 200, {
          mode,
          paperAccount,
          signals: recent.map(({ body: _body, bodyHash: _bodyHash, ...row }) => row),
          positions: positions.map(({ snapshot, ...row }) => ({
            ...row,
            snapshot,
          })),
        });
      } catch {
        json(res, 503, { error: { code: "storage_unavailable" } });
      }
      return;
    }
    if (path !== "/api/trading/signals" || req.method !== "POST") {
      json(res, 404, { error: { code: "not_found" } });
      return;
    }
    try {
      const signal = await parseBody(req);
      const validation = validateSignal(signal, clock());
      if (validation.status !== 200) {
        json(res, validation.status, {
          accepted: false,
          error: validation.error,
        });
        return;
      }
      const saved = await store.enqueue(signal);
      if (saved.kind === "conflict") {
        json(res, 409, {
          accepted: false,
          error: { code: "source_signal_id_conflict" },
        });
        return;
      }
      json(res, 202, {
        accepted: true,
        signal: {
          status: saved.status ?? "pending",
          sourceSignalId: signal.sourceSignalId,
          duplicate: saved.kind === "duplicate",
        },
      });
    } catch (error) {
      const status = error.status ?? (error instanceof TypeError ? 400 : 503);
      json(res, status, {
        accepted: false,
        error: { code: status === 503 ? "storage_unavailable" : error.message },
      });
    }
  });
}

export async function start() {
  if (!process.env.TRADING_INGEST_TOKEN)
    throw new Error("TRADING_INGEST_TOKEN is required");
  if (
    process.env.PAPER_ONLY_SIGNAL === "false" ||
    process.env.EXECUTION_MODE === "live"
  )
    throw new Error("PAPER_ONLY_SIGNAL: live mode is not approved");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  // Mandatory schema gate. The bot never creates tables on startup.
  try {
    await pool.query("SELECT source_signal_id FROM btb_signals LIMIT 0");
    await pool.query("SELECT source_signal_id FROM btb_positions LIMIT 0");
    await pool.query("SELECT id FROM btb_events LIMIT 0");
    await pool.query("SELECT singleton FROM btb_paper_account WHERE singleton = true");
  } catch (error) {
    await pool.end();
    throw new Error("Bot schema is missing; apply schema.sql to its database before starting", { cause: error });
  }
  const store = createStore(pool);
  const exchange = createBybit({});
  const worker = createWorker({ store, exchange, mode: "paper" });
  const server = createServer({
    store,
    token: process.env.TRADING_INGEST_TOKEN,
  });
  const port = Number(process.env.PORT || 3003);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  process.stdout.write(`Bullet trading receiver listening on ${port} (PAPER_ONLY_SIGNAL)\n`);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await worker.tick();
    } catch (error) {
      process.stderr.write(`Worker tick failed: ${error.name || "Error"}\n`);
    } finally {
      busy = false;
    }
  }, 3000);
  timer.unref();
  const shutdown = async () => {
    clearInterval(timer);
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  return { server, store, worker, pool, shutdown };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  start().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}