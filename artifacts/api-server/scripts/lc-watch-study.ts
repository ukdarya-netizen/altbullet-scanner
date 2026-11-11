/**
 * Liquidation Cascade fitted on its own candidates (owner 2026-11-11: "the metrics are saved — fit LC on the
 * champions"). Universe: every LC watch in liq_cascade_watch (14.07 → now, ~11k), each with the snapshot the
 * bot took at the detection (price24h / 1h, OI 30m / 1h / 4h, spot volume, CVD 30m / 1h / 4h, long
 * liquidations 1h / 4h / 24h, liq exhausted, global long %, large bid, liq orders, cycles, entry reason) and
 * whether it fired (signal_id) or why it missed (miss_reason).
 *
 * Outcome (BingX 15m candles, nothing from the future in the readings):
 *   A) entry at the detection (the price at the first 15m close after detected_at);
 *   B) entry at the live capitulation candle: the first 15m candle in the watch window (≤ 72h) with
 *      range ≥ 5.6% and body −3.5 … −5.5% (as live LC), at its close; "none" if no such candle.
 *   champion = +10% before −8%; LC exit = stop −8%, B.U. at +8%, trailing from +15% at 10 p.p., 4 days, fee 0.1%.
 * Readings added from the candles at the detection: the detection 15m candle's range / body / lower wick,
 * the drop from the 24h high, BTC's 24h change.
 *
 * Out: summary.txt — fired vs not, by miss reason; for every reading: 5 equal groups (range, n, champions %,
 *      average LC-exit result A and B); categorical readings by value; the champions by name;
 *      watches.csv (every watch with readings and outcomes).
 *
 * The script does not connect to any database. The agent exports with its read-only production SQL tool:
 *   SELECT * FROM liq_cascade_watch ORDER BY detected_at          → JSON array of row objects
 * Run (from artifacts/api-server; BingX candles via the study cache):
 *   pnpm dlx tsx scripts/lc-watch-study.ts --watches <json> --out ../../reports/lc-watch
 */
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { type C, type Row, D1, H1, M15, ensureDir, idxAtOrBefore, klines, parseArgs, writeCsv } from "./study-v2/lib.js";

const args = parseArgs();
const OUT = args.get("out") ?? "lc-watch";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const FILE = args.get("watches");
const HORIZON = 4 * D1, WINDOW = 3 * D1;
const NUM = ["price24h_at_detect", "price1h_at_detect", "oi30m_at_detect", "oi1h_at_detect", "oi4h_at_detect", "spot_vol24h_at_detect", "spot_vol_mult_at_detect",
  "spot_vol_mcap_pct", "long_liq1h_at_detect", "long_liq4h_at_detect", "long_liq24h_at_detect", "global_long_pct", "large_bid_usd", "liq_orders_count_at_detect",
  "liq_orders_usd_at_detect", "cycle_count_at_detect", "det_range_pct", "det_body_pct", "det_lower_wick_pct", "drop_from_24h_high_pct", "btc_24h_pct"];
const CAT = ["entry_reason", "cvd30m_at_detect", "cvd1h_at_detect", "cvd4h_at_detect", "liq_exhausted", "fired", "miss_reason", "capitulation_found"];

const parseT = (v: unknown) => { const s = String(v); return Date.parse(/[zZ]|[+-]\d\d(:?\d\d)?$/.test(s) ? s : `${s.replace(" ", "T")}Z`); };

function trade(m15: C[], i0: number, now: number) {
  const entry = m15[i0]!.close, at = m15[i0]!.time + M15;
  let peak = entry, stop = entry * 0.92, how = "стоп", champion: boolean | null = null, res: number | null = null;
  for (let i = i0 + 1; i < m15.length; i++) {
    const c = m15[i]!;
    if (c.time >= at + HORIZON || c.time > now) break;
    if (champion === null && c.low <= entry * 0.92) champion = false;
    if (c.low <= stop) { res = (Math.min(stop, c.open) / entry - 1) * 100 - 0.1; break; }
    peak = Math.max(peak, c.high);
    if (champion === null && peak >= entry * 1.1) champion = true;
    const pp = (peak / entry - 1) * 100;
    if (pp >= 8 && stop < entry) { stop = entry; how = "безубыток"; }
    if (pp >= 15) { const ts = entry * (1 + (pp - 10) / 100); if (ts > stop) { stop = ts; how = "трейлинг"; } }
  }
  if (res === null) {
    if (at + HORIZON > now) return { entry, at, peak: (peak / entry - 1) * 100, champion, result: null as number | null, how: "идёт" };
    const j = idxAtOrBefore(m15, at + HORIZON - M15);
    res = (m15[j]!.close / entry - 1) * 100 - 0.1; how = "4 дня";
  }
  return { entry, at, peak: (peak / entry - 1) * 100, champion: champion ?? false, result: res, how };
}

async function main() {
  if (!FILE) throw new Error("--watches <json file> is required");
  ensureDir(OUT); ensureDir(CACHE);
  const now = Date.now();
  const watches = (JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>[]).filter((w) => Number.isFinite(parseT(w.detected_at)));
  const t0 = Math.min(...watches.map((w) => parseT(w.detected_at)));
  const btc = await klines(CACHE, "BTC-USDT", "15m", t0 - 2 * D1, now);
  const bySym = new Map<string, Record<string, unknown>[]>();
  for (const w of watches) bySym.set(String(w.symbol), [...(bySym.get(String(w.symbol)) ?? []), w]);
  const rows: Row[] = [];
  let done = 0;
  for (const [symbol, ws] of bySym) {
    const first = Math.min(...ws.map((w) => parseT(w.detected_at)));
    const m15 = await klines(CACHE, symbol, "15m", first - 2 * D1, now).catch(() => [] as C[]);
    for (const w of ws) {
      const det = parseT(w.detected_at);
      const row: Row = {};
      for (const k of [...NUM, "entry_reason", "cvd30m_at_detect", "cvd1h_at_detect", "cvd4h_at_detect", "liq_exhausted", "miss_reason"]) if (k in w) row[k] = (w[k] ?? null) as Row[string];
      row.symbol = symbol; row.watch_id = Number(w.id); row.detected_utc = new Date(det).toISOString(); row.fired = w.signal_id != null ? 1 : 0; row.status = String(w.status ?? "");
      for (const k of NUM) if (row[k] != null && row[k] !== "") row[k] = Number(row[k]);
      const iDet = idxAtOrBefore(m15, det - M15); // detection candle = the last closed 15m before / at the detection
      if (iDet >= 0 && m15[iDet]!.time + M15 > det - 2 * M15) {
        const c = m15[iDet]!;
        row.det_range_pct = Math.round(((c.high - c.low) / c.open) * 1000) / 10;
        row.det_body_pct = Math.round(((c.close - c.open) / c.open) * 1000) / 10;
        row.det_lower_wick_pct = Math.round(((Math.min(c.open, c.close) - c.low) / c.open) * 1000) / 10;
        let hi = 0;
        for (let k = Math.max(0, iDet - 95); k <= iDet; k++) hi = Math.max(hi, m15[k]!.high);
        row.drop_from_24h_high_pct = Math.round(((c.close / hi) - 1) * 1000) / 10;
      }
      const ib = idxAtOrBefore(btc, det - M15), ib0 = idxAtOrBefore(btc, det - D1 - M15);
      if (ib >= 0 && ib0 >= 0) row.btc_24h_pct = Math.round(((btc[ib]!.close / btc[ib0]!.close) - 1) * 1000) / 10;
      // A: entry at the detection
      const iA = m15.findIndex((c) => c.time + M15 >= det);
      if (iA >= 0 && m15[iA]!.time < det + H1) {
        const a = trade(m15, iA, now);
        row.peak_a = Math.round(a.peak * 10) / 10; row.champion_a = a.champion === null ? null : a.champion ? 1 : 0;
        row.result_a = a.result === null ? null : Math.round(a.result * 100) / 100; row.how_a = a.how;
      }
      // B: entry at the first live-rule capitulation candle in the window
      let iB = -1;
      for (let k = iA; iA >= 0 && k < m15.length && m15[k]!.time < det + WINDOW && m15[k]!.time + M15 <= now; k++) {
        const c = m15[k]!;
        const range = ((c.high - c.low) / c.open) * 100, body = ((c.close - c.open) / c.open) * 100;
        if (range >= 5.6 && body <= -3.5 && body >= -5.5) { iB = k; break; }
      }
      row.capitulation_found = iB >= 0 ? 1 : 0;
      if (iB >= 0) {
        const b = trade(m15, iB, now);
        row.capitulation_utc = new Date(b.at).toISOString();
        row.peak_b = Math.round(b.peak * 10) / 10; row.champion_b = b.champion === null ? null : b.champion ? 1 : 0;
        row.result_b = b.result === null ? null : Math.round(b.result * 100) / 100; row.how_b = b.how;
      }
      rows.push(row);
    }
    if (++done % 50 === 0) console.error(`монеты ${done}/${bySym.size}, наблюдений ${rows.length}`);
  }
  writeCsv(join(OUT, "watches.csv"), rows);
  const avg = (rs: Row[], k: string) => { const xs = rs.map((r) => r[k]).filter((x): x is number => typeof x === "number"); return xs.length ? Math.round((100 * xs.reduce((a, b) => a + b, 0)) / xs.length) / 100 : "—"; };
  const pct = (rs: Row[], k: string) => { const xs = rs.filter((r) => r[k] === 0 || r[k] === 1); return xs.length ? Math.round((100 * xs.filter((r) => r[k] === 1).length) / xs.length) : "—"; };
  const line = (rs: Row[]) => `n ${rs.length} | A чемп ${pct(rs, "champion_a")}% ср ${avg(rs, "result_a")}% | капитуляция найдена ${pct(rs, "capitulation_found")}% · B чемп ${pct(rs, "champion_b")}% ср ${avg(rs, "result_b")}%`;
  const out: string[] = [
    `LC на своих кандидатах (liq_cascade_watch) · наблюдений ${rows.length}, монет ${bySym.size} · ${new Date(t0).toISOString()} … сейчас`,
    `A = вход на обнаружении; B = вход на первой свече капитуляции по живому правилу (диапазон ≥ 5.6%, тело −3.5…−5.5%) за 72 ч.`,
    `чемп = +10% раньше −8%; итог = выход LC (стоп −8%, Б.У. +8, трейл +15/10, 4 дня, комиссия 0.1%).`,
    ``,
    `Все:            ${line(rows)}`,
    `Сработали LC:   ${line(rows.filter((r) => r.fired === 1))}`,
    `Не сработали:   ${line(rows.filter((r) => r.fired === 0))}`,
  ];
  for (const k of CAT) {
    const vals = [...new Set(rows.map((r) => String(r[k] ?? "null")))];
    if (vals.length > 25) continue;
    out.push(``, `${k}:`);
    for (const v of vals.sort()) { const rs = rows.filter((r) => String(r[k] ?? "null") === v); if (rs.length >= 10) out.push(`  ${v.padEnd(40)} ${line(rs)}`); }
  }
  out.push(``, `Показатели — 5 равных групп (диапазон):`);
  for (const k of NUM) {
    const rs = rows.filter((r) => typeof r[k] === "number" && Number.isFinite(r[k] as number)).sort((a, b) => Number(a[k]) - Number(b[k]));
    if (rs.length < 50) { out.push(` ${k}: мало данных (${rs.length})`); continue; }
    out.push(` ${k} (n ${rs.length}):`);
    for (let q = 0; q < 5; q++) {
      const sl = rs.slice(Math.floor((q * rs.length) / 5), Math.floor(((q + 1) * rs.length) / 5));
      out.push(`   [${sl[0]![k]} … ${sl.at(-1)![k]}] ${line(sl)}`);
    }
  }
  const champs = rows.filter((r) => r.champion_a === 1 && r.fired === 0).sort((a, b) => Number(b.peak_a) - Number(a.peak_a));
  out.push(``, `Чемпионы, которые бот не взял (вход на обнаружении), ${champs.length}, лучшие 60:`);
  for (const r of champs.slice(0, 60)) out.push(`  ${String(r.symbol).padEnd(16)} ${r.detected_utc} пик +${r.peak_a}% · итог A ${r.result_a}% · капитуляция ${r.capitulation_found ? `${r.capitulation_utc} B ${r.result_b}%` : "нет"} · промах ${r.miss_reason ?? "—"} · 24ч ${r.price24h_at_detect} · OI30м ${r.oi30m_at_detect} · ликв.1ч ${r.long_liq1h_at_detect}`);
  writeFileSync(join(OUT, "summary.txt"), out.join("\n") + "\n");
  console.log(out.slice(0, 7).join("\n"));
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
