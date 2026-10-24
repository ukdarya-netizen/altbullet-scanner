/**
 * Position Batch Update — Telegram команда /update
 * Отправляет карточку для каждой открытой позиции с обогащением:
 *   WI (whale index per-token), SNF 1h (spot net flow), MAX PAIN LIQ
 */

import { db, trackedSignalsTable } from "@workspace/db";
import type { TrackedSignal } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { getFutureTickers } from "./bingx.js";
import { getTokenWhaleIndex } from "./whale_index.js";
import { getSpotNetflowEntry } from "./spot-netflow-cache.js";
import { sendMessage, sendMessageResult, getTargets } from "./telegram.js";
import { logger } from "./logger.js";
import { fmtP, fmtPct } from "./positionsReport.js";
import {
  fmtPositionProtectionLine,
  fmtPattern,
  hasEarnedBuProtection,
  tickerTag,
} from "./watcher-formatters.js";

// ── Format helpers ──────────────────────────────────────────────────────────

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function symBase(symbol: string): string {
  return symbol.replace("-USDT", "");
}

function pnlOf(s: TrackedSignal, curPrice: number | undefined): number | null {
  if (!curPrice || !s.entryPrice || s.entryPrice === 0) return null;
  const diff = curPrice - s.entryPrice;
  return ((s.isShort ? -diff : diff) / s.entryPrice) * 100;
}

function peakPnlOf(s: TrackedSignal): number | null {
  if (!s.peakPrice || !s.entryPrice || s.entryPrice === 0) return null;
  return ((s.peakPrice - s.entryPrice) / s.entryPrice) * 100;
}

function ageLabel(detectedAt: Date): string {
  const h = (Date.now() - detectedAt.getTime()) / 3_600_000;
  if (h < 1) return `${Math.round(h * 60)}мин`;
  if (h < 24) return `${h.toFixed(0)}ч`;
  return `${(h / 24).toFixed(1)}д`;
}

// ── Enrichment ──────────────────────────────────────────────────────────────

export interface PositionEnrichment {
  obRatio: number | null;
  obBidsUsd: number | null;
  obAsksUsd: number | null;
  whaleIndex: number | null;
  snfNetPct1h: number | null; // net taker flow 1h как % от суммарного объёма
  snfNetPct4h: number | null;
  longMaxPain: number | null;
  shortMaxPain: number | null;
}

async function fetchEnrichment(
  symbols: string[],
): Promise<Map<string, PositionEnrichment>> {
  const results = new Map<string, PositionEnrichment>();

  // SNF — in-memory cache (instant, fail-open null)
  const snfMap = new Map<
    string,
    { pct1h: number | null; pct4h: number | null }
  >(
    symbols.map((sym) => {
      const e = getSpotNetflowEntry(sym);
      return [sym, { pct1h: e?.netPct1h ?? null, pct4h: e?.netPct4h ?? null }];
    }),
  );

  // WI + MAX PAIN — параллельные запросы на CG (кэшированы per-symbol)
  await Promise.allSettled(
    symbols.map(async (sym) => {
      const wi = await getTokenWhaleIndex(sym).catch(() => null);
      const snf = snfMap.get(sym);
      results.set(sym, {
        obRatio: null,
        obBidsUsd: null,
        obAsksUsd: null,
        whaleIndex: wi,
        snfNetPct1h: snf?.pct1h ?? null,
        snfNetPct4h: snf?.pct4h ?? null,
        longMaxPain: null,
        shortMaxPain: null,
      });
    }),
  );

  return results;
}

// ── Card formatter ──────────────────────────────────────────────────────────

export function buildPositionCard(
  s: TrackedSignal,
  priceMap: Map<string, number>,
  enrich: PositionEnrichment,
): string {
  const sym = symBase(s.symbol);
  const curPrice = priceMap.get(s.symbol);
  const pnl = pnlOf(s, curPrice);
  const peak = peakPnlOf(s);

  const statusEmoji = s.status === "in_run" ? "🚀" : "👁";

  const lines: string[] = [];

  // ── Заголовок ──
  lines.push(
    `${statusEmoji} <b>${sym}</b> ${tickerTag(s.symbol)} | ⏱ ${ageLabel(s.detectedAt)}`,
  );
  lines.push(fmtPattern(s));

  // ── Цена / PnL ──
  if (curPrice != null && s.entryPrice != null) {
    const pnlStr = pnl != null ? ` (${fmtPct(pnl)})` : "";
    const peakStr = peak != null ? ` | Пик: +${peak.toFixed(1)}%` : "";
    lines.push(
      `💰 ${fmtP(s.entryPrice)} → ${fmtP(curPrice)}${pnlStr}${peakStr}`,
    );
  }

  // ── Тейк / защита ──
  const protectionLine = fmtPositionProtectionLine(s, { omitUnearned: true });
  if (protectionLine) lines.push(protectionLine);

  // A reached BE milestone is authoritative. Never follow it with an obsolete
  // initial −10% stop level from the signal row.
  if (!hasEarnedBuProtection(s)) {
    if (s.trailingStopLevel) {
      lines.push(`🛡 Trailing stop: ${fmtP(s.trailingStopLevel)}`);
    } else if (s.symbol === "BTC-USDT" || s.symbol === "BTCUSDT") {
      lines.push(`🛡 Stop Loss BTC: ${fmtP(s.entryPrice * 0.99)} (−1.0%)`);
    } else if (s.stopLossPrice) {
      const src = s.stopSource === "liq_heatmap" ? " (heatmap)" : "";
      lines.push(`🛡 Stop: ${fmtP(s.stopLossPrice)}${src}`);
    } else if (s.stopLossPct) {
      lines.push(`🛡 Stop: −${s.stopLossPct.toFixed(1)}%`);
    }
  }

  lines.push("");

  // ── OB ──
  if (enrich.obRatio != null) {
    const signal =
      enrich.obRatio >= 2.0
        ? "🟢 накопление"
        : enrich.obRatio >= 1.5
          ? "🟡 бид-стена"
          : "⚪ нейтрально";
    const bids =
      enrich.obBidsUsd != null ? ` | Bids: ${fmtUsd(enrich.obBidsUsd)}` : "";
    lines.push(`📦 OB: ${enrich.obRatio.toFixed(2)}×${bids} ${signal}`);
  } else {
    lines.push(`📦 OB: нет в пуле`);
  }

  // ── WI ──
  if (enrich.whaleIndex != null) {
    const v = enrich.whaleIndex;
    const mood =
      v >= 10
        ? "киты накапл. 🟢"
        : v <= -10
          ? "киты продают 🔴"
          : "нейтрально ⚪";
    lines.push(`🐳 WI: ${v >= 0 ? "+" : ""}${v.toFixed(0)} (${mood})`);
  } else {
    lines.push(`🐳 WI: нет данных`);
  }

  // ── SNF 1h ──
  if (enrich.snfNetPct1h != null) {
    const pct = enrich.snfNetPct1h;
    const sign = pct >= 0 ? "+" : "";
    const mood = pct > 5 ? "покупки 🟢" : pct < -5 ? "продажи 🔴" : "нейтр. ⚪";
    const pct4hStr =
      enrich.snfNetPct4h != null
        ? ` | 4h: ${enrich.snfNetPct4h >= 0 ? "+" : ""}${enrich.snfNetPct4h.toFixed(1)}%`
        : "";
    lines.push(`🌊 SNF 1h: ${sign}${pct.toFixed(1)}%${pct4hStr} (${mood})`);
  } else {
    lines.push(`🌊 SNF 1h: нет данных`);
  }

  // ── MAX PAIN ──
  if (enrich.longMaxPain != null && enrich.shortMaxPain != null) {
    lines.push(
      `💀 Max Pain: Long ${fmtP(enrich.longMaxPain)} / Short ${fmtP(enrich.shortMaxPain)}`,
    );
  } else {
    lines.push(`💀 Max Pain: нет данных`);
  }

  return lines.join("\n");
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Отправить батч-апдейт по всем открытым позициям.
 * chatId — ответить конкретному чату (команда пользователя);
 * если undefined — разослать всем подписчикам (периодический апдейт).
 */
export async function sendPositionBatchUpdate(
  chatId?: number | string,
): Promise<{ attempted: number; sent: number }> {
  const t0 = Date.now();

  const allOpen = await db
    .select()
    .from(trackedSignalsTable)
    .where(inArray(trackedSignalsTable.status, ["active", "in_run"]))
    .catch(() => [] as TrackedSignal[]);

  const targets = chatId
    ? [chatId]
    : await getTargets().catch(() => [] as (number | string)[]);
  if (targets.length === 0) return { attempted: 0, sent: 0 };

  if (allOpen.length === 0) {
    let sent = 0;
    for (const t of targets) {
      if (
        chatId === undefined
          ? (
              await sendMessageResult(t, "📊 <b>Нет открытых позиций</b>", {
                requireActiveSubscription: true,
              })
            ).ok
          : await sendMessage(t, "📊 <b>Нет открытых позиций</b>")
      ) {
        sent++;
      }
    }
    return { attempted: targets.length, sent };
  }

  const symbols = allOpen.map((s) => s.symbol);

  // Параллельно: обогащение + текущие цены
  const [enrichmentMap, priceMap] = await Promise.all([
    fetchEnrichment(symbols),
    getFutureTickers()
      .then((tickers: { symbol: string; lastPrice: string }[]) => {
        const m = new Map<string, number>();
        for (const t of tickers) m.set(t.symbol, parseFloat(t.lastPrice) || 0);
        return m;
      })
      .catch(() => new Map<string, number>()),
  ]);

  const moscowTime = new Date().toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  const inRunCount = allOpen.filter((s) => s.status === "in_run").length;
  const watchCount = allOpen.length - inRunCount;
  const parts: string[] = [];
  if (inRunCount > 0) parts.push(`🚀 ${inRunCount} в полёте`);
  if (watchCount > 0) parts.push(`👁 ${watchCount} в наблюдении`);

  const header = [
    `📊 <b>Position Update</b> — <i>${moscowTime} МСК</i>`,
    parts.join(" | "),
  ]
    .filter(Boolean)
    .join("\n");

  const emptyEnrich: PositionEnrichment = {
    obRatio: null,
    obBidsUsd: null,
    obAsksUsd: null,
    whaleIndex: null,
    snfNetPct1h: null,
    snfNetPct4h: null,
    longMaxPain: null,
    shortMaxPain: null,
  };

  let attempted = 0;
  let sent = 0;
  for (const target of targets) {
    attempted++;
    if (
      (chatId === undefined
        ? await sendMessageResult(target, header, {
            requireActiveSubscription: true,
          })
        : { ok: await sendMessage(target, header) }
      ).ok
    ) {
      sent++;
    }

    for (const signal of allOpen) {
      const enrich = enrichmentMap.get(signal.symbol) ?? emptyEnrich;
      const card = buildPositionCard(signal, priceMap, enrich);
      attempted++;
      if (
        (chatId === undefined
          ? await sendMessageResult(target, card, {
              requireActiveSubscription: true,
            })
          : { ok: await sendMessage(target, card) }
        ).ok
      ) {
        sent++;
      }
      // Небольшая задержка между сообщениями — Telegram rate limit
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  logger.info(
    {
      positions: allOpen.length,
      durationMs: Date.now() - t0,
    },
    "sendPositionBatchUpdate: завершён",
  );
  return { attempted, sent };
}
