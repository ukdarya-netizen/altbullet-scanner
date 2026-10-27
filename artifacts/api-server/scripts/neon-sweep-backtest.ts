/**
 * Read-only ABNeon backtest: current support rule vs "sweep" variant.
 *
 * Current rule: a zone dies once any 4H low trades below its bottom after the
 * zone's latest pivot, and an arm dies on one 4H close >1% below the zone.
 * Sweep variant (K = 2, 3): a zone/arm dies only after K consecutive 4H closes
 * >1% below the bottom; wicks or short closes below that are reclaimed keep it.
 *
 * Uses the production detector (evaluateAbneonSupportBounce) unchanged except
 * for the research-only `sweepReclaimBars` input. Public BingX klines only; no
 * DB, no secrets, no writes outside the output folder.
 *
 * Simplifications (identical for every variant, so the comparison is fair):
 *  - volumeUsd = BingX quote volume (close × volume), not CoinGlass aggregated;
 *  - market cap unknown → turnover gate skipped (same as production when mcap
 *    is unavailable);
 *  - one open trade per symbol: no new signal until the previous one resolves.
 * Outcome = trading-bot rule: +5% before −8% stop on 15m candles within 72h,
 * stop first when both hit in one candle; fee 0.1%.
 *
 * Run (from artifacts/api-server):
 *   npx tsx scripts/neon-sweep-backtest.ts --days 42 --out ../../reports/oct30/neon_sweep
 * Optional: --symbols BULLA-USDT,AIN-USDT  --limit 300
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateAbneonSupportBounce,
  type ClosedDetectorCandle,
} from "../src/lib/stealth-abneon-detectors.js";

const H1 = 3_600_000;
const H4 = 4 * H1;
const M15 = 900_000;
const BASE = "https://open-api.bingx.com";
const WIN_PCT = 5;
const STOP_PCT = 8;
const FEE = 0.1;
const HORIZON_MS = 72 * H1;
const ARM_TTL_MS = 24 * H1;

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
}
const DAYS = Number(args.get("days") ?? 42);
const OUT = args.get("out") ?? "neon_sweep";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;

const VARIANTS: { name: string; sweep?: number }[] = [
  { name: "current" },
  { name: "sweep_k2", sweep: 2 },
  { name: "sweep_k3", sweep: 3 },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(path: string): Promise<any> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(BASE + path);
      const json = await res.json();
      if (json.code === 0) return json.data;
      last = new Error(`code ${json.code} ${json.msg}`);
    } catch (err) {
      last = err;
    }
    await sleep(800 * (attempt + 1));
  }
  throw last;
}

async function klines(
  symbol: string,
  interval: "15m" | "1h" | "4h",
  start: number,
  end: number,
): Promise<ClosedDetectorCandle[]> {
  const step = interval === "15m" ? M15 : interval === "1h" ? H1 : H4;
  const rows = new Map<number, ClosedDetectorCandle>();
  let cursor = start;
  while (cursor < end) {
    const pageEnd = Math.min(end, cursor + step * 1000);
    const data = (await getJson(
      `/openApi/swap/v3/quote/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${pageEnd}&limit=1000`,
    )) as Array<Record<string, string | number>>;
    for (const k of data ?? []) {
      const time = Number(k.time);
      const close = Number(k.close);
      const volume = Number(k.volume);
      rows.set(time, {
        time,
        open: Number(k.open),
        high: Number(k.high),
        low: Number(k.low),
        close,
        volume,
        volumeUsd: volume * close,
      });
    }
    cursor = pageEnd;
    await sleep(60);
  }
  return [...rows.values()].sort((a, b) => a.time - b.time);
}

type Signal = {
  variant: string;
  symbol: string;
  observedAt: number;
  triggerCandleTime: number;
  reason: string;
  frozenLevel: number;
  entry: number;
  label: "win" | "loss" | "censored" | "incomplete";
  netPct: number | null;
  hit10: boolean | null;
  peak: number;
};

/** Owner 2026-10-27 target: +10% before the -8% stop within 72h; and the 72h peak. */
function target10(m15: ClosedDetectorCandle[], from: number, entry: number): { hit10: boolean | null; peak: number } {
  let peak = 0;
  let hit10: boolean | null = null;
  for (const c of m15) {
    if (c.time < from) continue;
    if (c.time >= from + HORIZON_MS) break;
    peak = Math.max(peak, (c.high / entry - 1) * 100);
    if (hit10 === null && c.low <= entry * (1 - STOP_PCT / 100)) hit10 = false;
    if (hit10 === null && c.high >= entry * 1.1) hit10 = true;
  }
  if (hit10 === null) hit10 = from + HORIZON_MS > Date.now() ? null : false;
  return { hit10, peak };
}

function labelTrade(
  m15: ClosedDetectorCandle[],
  from: number,
  entry: number,
  now: number,
): { label: Signal["label"]; netPct: number | null; resolvedAt: number } {
  const target = entry * (1 + WIN_PCT / 100);
  const stop = entry * (1 - STOP_PCT / 100);
  for (const c of m15) {
    if (c.time < from) continue;
    if (c.time >= from + HORIZON_MS) break;
    if (c.low <= stop) return { label: "loss", netPct: -STOP_PCT - FEE, resolvedAt: c.time + M15 };
    if (c.high >= target) return { label: "win", netPct: WIN_PCT - FEE, resolvedAt: c.time + M15 };
  }
  if (from + HORIZON_MS > now) return { label: "incomplete", netPct: null, resolvedAt: Infinity };
  const last = m15.filter((c) => c.time < from + HORIZON_MS).at(-1);
  return {
    label: "censored",
    netPct: last ? (last.close / entry - 1) * 100 - FEE : null,
    resolvedAt: from + HORIZON_MS,
  };
}

function simulate(
  symbol: string,
  variant: { name: string; sweep?: number },
  h4: ClosedDetectorCandle[],
  h1: ClosedDetectorCandle[],
  m15: ClosedDetectorCandle[],
  from: number,
  now: number,
): Signal[] {
  const out: Signal[] = [];
  let arm: { level: number; time: number } | null = null;
  let busyUntil = -Infinity;
  for (let t = Math.ceil(from / M15) * M15; t <= now; t += M15) {
    if (t < busyUntil) continue;
    // Unarmed evaluation runs on 1H closes (scanner cadence is 30 min; the
    // detector only changes on closed 1H/4H candles). Armed: every 15m close.
    if (!arm && t % H1 !== 0) continue;
    const res = evaluateAbneonSupportBounce({
      // Production keeps ~600 bars of 4H history (zones use the last 600).
      candles4h: h4.filter((c) => c.time + H4 <= t && c.time >= t - 640 * H4),
      candles1h: h1.filter((c) => c.time + H1 <= t && c.time >= t - 30 * H1),
      candles15m: arm ? m15.filter((c) => c.time + M15 <= t && c.time >= t - 30 * M15) : undefined,
      observedAt: t,
      marketCapUsd: null,
      ...(arm ? { frozenLevel: arm.level, armCandleTime: arm.time } : {}),
      sweepReclaimBars: variant.sweep,
    });
    if (res.status === "qualified" && res.triggerCandleTime != null) {
      const trig =
        m15.find((c) => c.time === res.triggerCandleTime && res.reason.includes("15m")) ??
        h1.find((c) => c.time === res.triggerCandleTime);
      const entry = trig?.close ?? null;
      arm = null;
      if (entry == null) continue;
      const lab = labelTrade(m15, t, entry, now);
      const tg = target10(m15, t, entry);
      out.push({
        variant: variant.name,
        symbol,
        observedAt: t,
        triggerCandleTime: res.triggerCandleTime,
        reason: res.reason,
        frozenLevel: res.frozenLevel ?? NaN,
        entry,
        label: lab.label,
        netPct: lab.netPct,
        hit10: tg.hit10,
        peak: tg.peak,
      });
      busyUntil = lab.resolvedAt;
    } else if (res.status === "armed" && res.frozenLevel != null && res.armCandleTime != null) {
      if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime };
    } else if (arm && (res.status === "terminal" || t - arm.time > ARM_TTL_MS)) {
      arm = null;
    }
  }
  return out;
}

function summarize(signals: Signal[], from: number, now: number): string {
  const mid = from + (now - HORIZON_MS - from) / 2;
  const lines: string[] = [];
  const row = (name: string, rs: Signal[]) => {
    const done = rs.filter((s) => s.label === "win" || s.label === "loss");
    const wins = done.filter((s) => s.label === "win").length;
    const exp = done.length ? done.reduce((a, s) => a + (s.netPct ?? 0), 0) / done.length : NaN;
    const days = new Set(rs.map((s) => new Date(s.observedAt).toISOString().slice(0, 10))).size;
    const t10 = rs.filter((s) => s.hit10 !== null);
    const h10 = t10.filter((s) => s.hit10).length;
    const c20 = rs.filter((s) => s.peak >= 20).length;
    lines.push(
      `${name.padEnd(40)} +10%_before_stop=${t10.length ? Math.round((100 * h10) / t10.length) : 0}% (${h10}/${t10.length}) peaks>=20%=${c20} | n=${String(done.length).padStart(4)} win=${done.length ? Math.round((100 * wins) / done.length) : 0}% exp=${exp.toFixed(2)}% censored=${rs.filter((s) => s.label === "censored").length} days=${days} symbols=${new Set(rs.map((s) => s.symbol)).size}`,
    );
  };
  const key = (s: Signal) => `${s.symbol}|${s.triggerCandleTime}`;
  const base = new Set(signals.filter((s) => s.variant === "current").map(key));
  for (const v of VARIANTS) {
    const rs = signals.filter((s) => s.variant === v.name);
    lines.push(`== ${v.name}`);
    row("all", rs);
    row("first half", rs.filter((s) => s.observedAt < mid));
    row("second half", rs.filter((s) => s.observedAt >= mid));
    if (v.name !== "current") {
      const own = new Set(rs.map(key));
      const added = rs.filter((s) => !base.has(key(s)));
      const removed = signals.filter((s) => s.variant === "current" && !own.has(key(s)));
      row("ADDED vs current", added);
      row("ADDED first half", added.filter((s) => s.observedAt < mid));
      row("ADDED second half", added.filter((s) => s.observedAt >= mid));
      row("REMOVED vs current", removed);
    }
  }
  return lines.join("\n");
}

async function main() {
  const now = Date.now();
  const from = now - DAYS * 24 * H1;
  let symbols: string[];
  if (ONLY) symbols = ONLY;
  else {
    const contracts = (await getJson("/openApi/swap/v2/quote/contracts")) as Array<{ symbol: string; status?: number }>;
    symbols = contracts
      .map((c) => c.symbol)
      .filter((s) => s.endsWith("-USDT") && !s.startsWith("BTC-"))
      .slice(0, LIMIT);
  }
  mkdirSync(OUT, { recursive: true });
  const all: Signal[] = [];
  const errors: Record<string, string> = {};
  let done = 0;
  for (const symbol of symbols) {
    try {
      const h4 = await klines(symbol, "4h", from - 620 * H4, now);
      const h1 = await klines(symbol, "1h", from - 40 * H1, now);
      const m15 = await klines(symbol, "15m", from - 40 * M15, now);
      if (h4.length < 50 || h1.length < 50) {
        errors[symbol] = "short_history";
      } else {
        for (const v of VARIANTS) all.push(...simulate(symbol, v, h4, h1, m15, from, now));
      }
    } catch (err) {
      errors[symbol] = String(err).slice(0, 120);
    }
    done++;
    if (done % 25 === 0) console.error(`${done}/${symbols.length} symbols, ${all.length} signals`);
  }
  const header = "variant,symbol,observed_at,trigger_candle,reason,frozen_level,entry,label,net_pct,hit10,peak72";
  writeFileSync(
    join(OUT, "signals.csv"),
    [header, ...all.map((s) => [s.variant, s.symbol, new Date(s.observedAt).toISOString(), new Date(s.triggerCandleTime).toISOString(), s.reason, s.frozenLevel, s.entry, s.label, s.netPct ?? "", s.hit10 === null ? "" : s.hit10 ? 1 : 0, s.peak.toFixed(2)].join(","))].join("\n"),
  );
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  const summary = `period ${new Date(from).toISOString()} .. ${new Date(now).toISOString()}, symbols ${symbols.length}, errors ${Object.keys(errors).length}\n` + summarize(all, from, now);
  writeFileSync(join(OUT, "summary.txt"), summary);
  console.log(summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
