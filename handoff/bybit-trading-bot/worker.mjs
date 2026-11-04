import { createHash } from "node:crypto";
import { SIGNAL_TTL_MS, validateSignal } from "./contract.mjs";
import { initialPosition, evaluatePosition } from "./engine.mjs";

const safeReason = (error) =>
  error instanceof Error ? error.name + ": " + error.message.slice(0, 300) : "Unknown error";

function orderLinkId(id, suffix = "") {
  return `btb-${createHash("sha256").update(id).digest("hex").slice(0, 25)}${suffix}`;
}

/** One leader-locked pass; all durable operations use the store's PostgreSQL tables. */
export function createWorker({ store, exchange, mode = "paper", clock = Date.now }) {
  if (!["paper", "live"].includes(mode)) throw new Error("Invalid execution mode");
  // The exchange adapter is implemented, but live exit reconciliation is not
  // independently proven. Never open a real position that this worker cannot
  // subsequently manage safely.
  if (mode === "live")
    throw new Error("PAPER_ONLY_SIGNAL: live execution is not available");
  if (!store || !exchange) throw new Error("Store and exchange are required");

  async function open(row) {
    const signal = row.body;
    const id = signal.sourceSignalId;
    if (row.status === "opening") {
      const existing = (await store.listOpenPositions()).find((p) => p.sourceSignalId === id);
      if (existing) {
        await store.setSignalStatus(id, "open");
        return;
      }
      if (mode === "live") {
        // A lost HTTP response is not proof that a market order failed. An
        // operator must reconcile exchange orders before any new entry.
        await store.setSignalStatus(id, "error", "entry_outcome_requires_exchange_reconciliation");
        return;
      }
    }
    const result = validateSignal(signal, clock());
    if (result.status !== 200) {
      await store.setSignalStatus(id, "rejected", result.error.code);
      return;
    }
    if (clock() - Date.parse(signal.signalAt) >= SIGNAL_TTL_MS) {
      await store.setSignalStatus(id, "rejected", "stale_at_execution");
      return;
    }

    // Instrument validation happens before an attempted entry; a confirmed
    // Bullet signal is not automatically tradeable at Bybit minimum size.
    try {
      await exchange.validateOrder(signal);
    } catch (error) {
      await store.setSignalStatus(id, "rejected", safeReason(error));
      return;
    }
    await store.setSignalStatus(id, "opening");
    if (mode === "paper") {
      const quote = await exchange.ticker(signal.symbol);
      const price = Number(quote.ask1Price || quote.lastPrice);
      // Sender sizing is for $10 initial isolated margin at 10x. A market
      // move cannot silently enlarge the PAPER position beyond $100 notional.
      if (!Number.isFinite(price) || Number(signal.quantity) * price > 100.000001) {
        await store.setSignalStatus(id, "rejected", "entry_notional_exceeds_10_usd_at_10x");
        return;
      }
      const position = initialPosition(signal, {
        price,
        quantity: Number(signal.quantity),
        at: new Date(clock()).toISOString(),
        mode,
      });
      const reserved = await store.openPaperPosition({
        ...position,
        marginHeldUsd: 10,
        realizedPnlUsdt: 0,
      });
      if (reserved.kind === "insufficient") {
        await store.setSignalStatus(id, "rejected", "insufficient_free_paper_balance");
        return;
      }
      await store.setSignalStatus(id, "open");
      if (reserved.kind === "opened") {
        await store.recordEvent(id, "paper_entry", {
          price,
          quantity: position.quantity,
          initialStop: position.stopPrice,
        });
      }
      return;
    }

    // One-way netting cannot safely represent independent Bullet trades in
    // the same symbol. No market order is sent if one already exists.
    const other = await exchange.getPosition(signal.symbol);
    if (other.length) {
      await store.setSignalStatus(id, "rejected", "existing_exchange_position_same_symbol");
      return;
    }
    const wallet = await exchange.walletBalance();
    if (
      !Number.isFinite(Number(wallet.totalAvailableBalance)) ||
      Number(wallet.totalAvailableBalance) < 10
    ) {
      await store.setSignalStatus(id, "rejected", "insufficient_initial_margin");
      return;
    }
    const link = orderLinkId(id);
    // The live adapter attaches a market protective stop atomically to its
    // market entry; an accepted create-order response is NOT a fill.
    await exchange.openProtected(signal, { orderLinkId: link });
    const order = await exchange.getOrder(link);
    const positions = await exchange.getPosition(signal.symbol);
    const fill = positions.length === 1 ? positions[0] : null;
    if (
      order?.orderStatus !== "Filled" ||
      !fill ||
      fill.side !== "Buy" ||
      +fill.size <= 0 ||
      +fill.avgPrice <= 0 ||
      +fill.stopLoss <= 0
    ) {
      await store.setSignalStatus(id, "error", "entry_not_confirmed_or_stop_missing");
      return;
    }
    const position = initialPosition(signal, {
      price: Number(fill.avgPrice),
      quantity: Number(fill.size),
      at: new Date(clock()).toISOString(),
      mode,
    });
    await store.upsertPosition(position);
    await store.setSignalStatus(id, "open");
    await store.recordEvent(id, "exchange_entry_verified", {
      orderLinkId: link,
      price: position.entryPrice,
      quantity: position.quantity,
    });
  }

  async function watchPaper(record) {
    const position = record.snapshot;
    const quote = await exchange.ticker(position.symbol);
    const price = Number(quote.lastPrice);
    const result = evaluatePosition(position, {
      price,
      at: new Date(clock()).toISOString(),
    });
    let realized = Number(position.realizedPnlUsdt);
    if (result.actions.length) {
      for (const action of result.actions) {
        if (action.type !== "raise_stop") {
          realized += action.quantity * (price - position.entryPrice);
        }
      }
    }
    result.next.realizedPnlUsdt = Number(realized.toFixed(8));
    result.next.marginHeldUsd =
      result.next.status === "closed"
        ? 0
        : Number((10 * result.next.remainingQty / result.next.quantity).toFixed(8));
    // The wallet delta and the snapshot commit together; a failed event log
    // cannot double-credit a replayed paper close.
    const settled = await store.settlePaperPosition(position, result.next);
    if (settled.kind === "stale") return;
    if (result.next.status === "closed") {
      await store.setSignalStatus(position.sourceSignalId, "closed");
    }
    for (const action of result.actions) {
      await store.recordEvent(position.sourceSignalId, `paper_${action.type}`, {
        price,
        quantity: action.quantity,
        stopPrice: action.stopPrice ?? null,
        reason: action.reason,
      });
    }
  }

  async function watchLive(record) {
    const position = record.snapshot;
    const positions = await exchange.getPosition(position.symbol);
    const actual = positions.length === 1 ? positions[0] : null;
    if (
      !actual ||
      actual.side !== "Buy" ||
      Math.abs(Number(actual.size) - Number(position.remainingQty)) > 1e-8 ||
      +actual.stopLoss <= 0
    ) {
      // An external stop or manual action may have changed the position. Do
      // not issue another order until exchange state is reconciled.
      await store.upsertPosition({ ...position, status: "error" });
      await store.setSignalStatus(position.sourceSignalId, "error", "exchange_position_mismatch");
      return;
    }
    const quote = await exchange.ticker(position.symbol);
    const result = evaluatePosition(position, {
      price: Number(quote.lastPrice),
      at: new Date(clock()).toISOString(),
    });
    if (!result.actions.length) {
      await store.upsertPosition(result.next);
      return;
    }
    // A live stop update or reduce-only fill requires order-status and
    // position reconciliation; paper transitions must never be substituted
    // for exchange-confirmed fills.
    await store.upsertPosition({ ...position, status: "error" });
    await store.setSignalStatus(
      position.sourceSignalId,
      "error",
      "live_exit_requires_order_and_stop_reconciliation",
    );
  }

  async function tick() {
    return store.withLeaderLock(async () => {
      const next = await store.getPending(clock());
      if (next) {
        try {
          await open(next);
        } catch (error) {
          // Unknown exchange outcomes remain terminal for automated entry:
          // never retry a market order merely because a request timed out.
          await store.setSignalStatus(next.sourceSignalId, "error", safeReason(error));
        }
      }
      for (const record of await store.listOpenPositions()) {
        try {
          if (mode === "paper") await watchPaper(record);
          else await watchLive(record);
        } catch (error) {
          // Keep prior protection/position state on a transient price outage.
          // A paper quote failure can retry next tick; live errors fail closed.
          if (mode === "live") {
            await store.upsertPosition({ ...record.snapshot, status: "error" });
            await store.setSignalStatus(record.sourceSignalId, "error", safeReason(error));
          }
        }
      }
    });
  }
  return { tick };
}