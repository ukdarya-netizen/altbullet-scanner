/**
 * Stealth: 4H close vs 1H close (owner 2026-11-18, PIPPIN: «должен был выходить 4 часа назад… сигналы выдаются по
 * закрытию 4-часовой свечи? … пересмотреть это все»). Read-only, one run, nothing in the bot changes.
 *
 * The live rule (since 15.11): the closed 4H candle closes above the top of a DAILY ABNeon zone (previous 4H close at /
 * below it; the highest crossed zone is the level) and its Lucy's VSA bar (aggregated futures + spot USD, 120 bars) is
 * purple / white. The scan runs 45 s after the 4H close with the CoinGlass volume it gets at that moment.
 *
 * Here, for every BingX USDT perpetual over the last 30 days, on FINAL history:
 *   4h events — every 4H crossing of a daily zone top (any colour), with its Lucy colour;
 *   1h events — the same crossing on the closed 1H candle with the 1H Lucy colour (levels still daily);
 * for each event: level (top / bottom / pivots), how many zones crossed, the next resistance, candle shape, the
 * colour of the bar and of the 3 bars before, the 4H candle that holds a 1H event and its colour so far, price
 * already moved since the 24h low, BTC; outcomes on BingX 15m from the close (24h / 72h / 7d, peaks, +10 before −8,
 * simulated exits with the −8% stop). Live: every Stealth signal since 15.11 (fired.jsonl) is matched to its 4H
 * event; a bright 4H event with no live signal = the bot missed it (e.g. the volume it read 45 s after the close).
 *
 * Run (from artifacts/api-server; candle / CoinGlass cache of the earlier studies is reused):
 *   pnpm dlx tsx scripts/stealth-tf-study.ts --in ../../reports/stealth-tf-1118 --out ../../reports/stealth-tf-1118
 * Output: events.csv, live.csv (live signals ↔ events), errors.json, run.txt.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeSupportZones, type SupportZone } from "../src/lib/stealth-abneon-detectors.js";
import { lucyColour, closesAboveMiddle, LUCY_LONG_BARS } from "../src/lib/abneon-volume-gate.js";
import { cgHistory, type VBar } from "./study-v2/cg.js";
import { type C, type Row, D1, H1, H4, ensureDir, grid, idxAtOrBefore, klines, majors, parseArgs, path, pct, usdtSymbols, writeCsv } from "./study-v2/lib.js";

const args = parseArgs();
const IN = args.get("in") ?? "../../reports/stealth-tf-1118";
const OUT = args.get("out") ?? IN;
const CACHE = args.get("cache") ?? "../../reports/.cache";
const DAYS = Number(args.get("days") ?? 30);
const ONLY = args.get("symbols")?.split(",");
const ZONE_DAYS = 700;

function jsonl(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}
const time = (v: unknown): number | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = typeof v === "string" && !/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
  const t = typeof s === "number" ? s : Date.parse(s);
  return Number.isFinite(t) ? t : null;
};
const sym = (s: string) => (s.includes("-") ? s : s.replace(/USDT$/, "-USDT"));

/** Total USD volume per bar of `step` (futures required; spot halves all present or 0). */
function totals(fut: Map<number, VBar> | null, spot: Map<number, VBar> | null, step: number): Map<number, number> {
  const f = new Map<number, number>(), fn = new Map<number, number>(), s = new Map<number, number>(), sn = new Map<number, number>();
  for (const b of fut?.values() ?? []) { const k = Math.floor(b.time / step) * step; f.set(k, (f.get(k) ?? 0) + b.buy + b.sell); fn.set(k, (fn.get(k) ?? 0) + 1); }
  for (const b of spot?.values() ?? []) { const k = Math.floor(b.time / step) * step; s.set(k, (s.get(k) ?? 0) + b.buy + b.sell); sn.set(k, (sn.get(k) ?? 0) + 1); }
  const need = step / H1, out = new Map<number, number>();
  for (const [k, v] of f) if (fn.get(k) === need) out.set(k, v + (sn.get(k) === need ? s.get(k)! : 0));
  return out;
}
function colourAt(cs: C[], i: number, vol: Map<number, number>, step: number): string | null {
  if (i < LUCY_LONG_BARS - 1) return null;
  const v: number[] = [];
  for (let q = i - LUCY_LONG_BARS + 1; q <= i; q++) {
    if (q > i - LUCY_LONG_BARS + 1 && cs[q]!.time - cs[q - 1]!.time !== step) return null;
    const x = vol.get(cs[q]!.time);
    if (x == null) return null;
    v.push(x);
  }
  return lucyColour(v, v.length - 1);
}
const bright = (c: string | null) => (c === "M" || c === "W" ? 1 : c === null ? null : 0);

async function main() {
  ensureDir(OUT); ensureDir(CACHE);
  const now = Math.floor(Date.now() / H1) * H1;
  const from = now - DAYS * D1;
  const errors: Record<string, string> = {};
  const fired = jsonl(join(IN, "fired.jsonl")).map((r) => ({ id: String(r.id ?? ""), symbol: sym(String(r.symbol ?? "")), at: time(r.detected_at) ?? NaN, status: String(r.status ?? ""), pnl: r.pnl_percent ?? null, raw: r }));
  const symbols = ONLY ?? await usdtSymbols(CACHE);
  const btc = { h1: await klines(CACHE, "BTC-USDT", "1h", from - 30 * D1, now).catch(() => [] as C[]), h4: await klines(CACHE, "BTC-USDT", "4h", from - 60 * D1, now).catch(() => [] as C[]) };
  const rows: Row[] = [];
  let done = 0;
  for (const s of symbols) {
    try {
      const d1 = await klines(CACHE, s, "1d", now - (ZONE_DAYS + 40) * D1, now);
      const h4 = await klines(CACHE, s, "4h", from - 25 * D1, now);
      const h1 = await klines(CACHE, s, "1h", from - 7 * D1, now);
      if (h4.length < 60 || d1.length < 30) { done++; continue; }
      const m15 = await klines(CACHE, s, "15m", from - D1, now);
      const fut = await cgHistory(CACHE, s, "aggfut", from - 25 * D1, now).catch(() => null);
      const spot = await cgHistory(CACHE, s, "aggspot", from - 25 * D1, now).catch(() => null);
      const v1 = totals(fut, spot, H1), v4 = totals(fut, spot, H4);
      const zoneMemo = new Map<number, SupportZone[]>();
      const zonesAt = (t: number) => {
        const day = Math.floor(t / D1) * D1; // daily candles closed before the event's day … as live: closed days ≤ t
        const key = idxAtOrBefore(d1, t - D1);
        if (!zoneMemo.has(key)) zoneMemo.set(key, key >= 0 ? computeSupportZones(d1.slice(Math.max(0, key - ZONE_DAYS + 1), key + 1)) : []);
        void day;
        return zoneMemo.get(key)!;
      };
      const scan = (tf: "4h" | "1h", cs: C[], vol: Map<number, number>, step: number) => {
        for (let i = 1; i < cs.length; i++) {
          const c = cs[i]!, p = cs[i - 1]!;
          if (c.time < from || c.time - p.time !== step) continue;
          const closeAt = c.time + step;
          const zones = zonesAt(closeAt);
          const crossed = zones.filter((z) => p.close <= z.top && c.close > z.top).sort((a, b) => b.top - a.top);
          if (!crossed.length) continue;
          const lvl = crossed[0]!;
          const next = zones.filter((z) => z.top > c.close).sort((a, b) => a.bottom - b.bottom)[0] ?? null;
          const col = colourAt(cs, i, vol, step);
          let prevBright = 0, prevKnown = 0;
          for (let k = i - 3; k < i; k++) { const x = colourAt(cs, k, vol, step); if (x !== null) { prevKnown++; if (x !== "N") prevBright++; } }
          const r: Row = {
            symbol: s, tf, candle_open: new Date(c.time).toISOString(), close_at: new Date(closeAt).toISOString(), close_ms: closeAt,
            close: c.close, prev_close: p.close, level_top: lvl.top, level_bottom: lvl.bottom, level_pivots: lvl.count, zones_crossed: crossed.length,
            above_level_pct: pct(c.close, lvl.top), next_res_pct: next ? pct(next.bottom, c.close) : null,
            body_pct: pct(c.close, c.open), range_pct: pct(c.high, c.low), close_pos: c.high > c.low ? (c.close - c.low) / (c.high - c.low) : null,
            colour: col, bright: bright(col), buying: col !== null && col !== "N" && closesAboveMiddle(c) ? 1 : col === null ? null : 0,
            prev3_not_grey: prevKnown === 3 ? prevBright : null,
            vol_usd: vol.get(c.time) ?? null,
          };
          // 1H event: the 4H candle it sits in (its colour on FINAL data, i.e. what the 4H rule would see at its close).
          if (tf === "1h") {
            const k4 = Math.floor(c.time / H4) * H4, j = idxAtOrBefore(h4, k4);
            const c4 = j >= 0 && h4[j]!.time === k4 ? h4[j]! : null;
            r.h4_open = new Date(k4).toISOString();
            r.h4_colour = c4 ? colourAt(h4, j, v4, H4) : null;
            r.h4_close = c4?.close ?? null;
            r.h4_closes_above_level = c4 ? (c4.close > lvl.top ? 1 : 0) : null;
            r.hours_before_h4_close = (k4 + H4 - closeAt) / H1;
          }
          const lo24 = Math.min(...h1.filter((x) => x.time >= closeAt - D1 && x.time < closeAt).map((x) => x.low));
          r.from_low24_pct = Number.isFinite(lo24) ? pct(c.close, lo24) : null;
          Object.assign(r, majors("btc", btc.h1, btc.h4, closeAt));
          Object.assign(r, path(m15, closeAt, c.close, null));
          Object.assign(r, grid("g", m15, closeAt, c.close, { s8: c.close * 0.92 }));
          if (tf === "4h") {
            const f = fired.find((x) => x.symbol === s && x.at >= closeAt && x.at < closeAt + H4);
            r.live_id = f?.id ?? null; r.live_status = f?.status ?? null; r.live_pnl = (f?.pnl as number | null) ?? null;
          }
          rows.push(r);
        }
      };
      scan("4h", h4, v4, H4);
      scan("1h", h1, v1, H1);
    } catch (e) {
      errors[s] = String(e).slice(0, 160);
    }
    if (++done % 25 === 0) console.error(`${done}/${symbols.length} монет · событий ${rows.length}`);
  }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  writeCsv(join(OUT, "events.csv"), rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))));
  // Live Stealth signals ↔ the 4H events.
  const live: Row[] = fired.map((f) => {
    const ev = rows.filter((r) => r.tf === "4h" && r.symbol === f.symbol && (r.close_ms as number) <= f.at && f.at < (r.close_ms as number) + H4)[0];
    return { id: f.id, symbol: f.symbol, detected_at: new Date(f.at).toISOString(), status: f.status, pnl: (f.pnl as number | null) ?? null, matched_4h_close: ev ? (ev.close_at as string) : null, colour_final: ev ? (ev.colour as string | null) : null, level_top: ev ? (ev.level_top as number) : null };
  });
  writeCsv(join(OUT, "live.csv"), live);
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 2));
  const n4 = rows.filter((r) => r.tf === "4h"), n1 = rows.filter((r) => r.tf === "1h");
  writeFileSync(join(OUT, "run.txt"), [
    `монет: ${symbols.length}, ошибок: ${Object.keys(errors).length}, период: ${new Date(from).toISOString()} — ${new Date(now).toISOString()}`,
    `4h пересечений: ${n4.length} (ярких M/W: ${n4.filter((r) => r.bright === 1).length}); 1h пересечений: ${n1.length} (ярких: ${n1.filter((r) => r.bright === 1).length})`,
    `живых Stealth в fired.jsonl: ${fired.length}, сопоставлено с 4h событием: ${live.filter((r) => r.matched_4h_close).length}`,
  ].join("\n") + "\n");
  console.error("готово");
}

void main();
