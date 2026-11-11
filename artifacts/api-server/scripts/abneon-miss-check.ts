/**
 * Why ABNeon missed the owner's bounces (owner 2026-11-11): KNOTS 9–10.11, SI 9–10.11, GANG 6–8.11,
 * PRIORS 8–9.11 — the wait-study could not even load GANG / PRIORS (it needs 250 4H candles).
 * No minimum history here: the detector gets whatever BingX has, as the live bot does.
 *
 * Out: miss-check.txt — per coin, from --from (default 2026-11-04):
 *   every 4H close: OHLC, aggregated Welkin colour, the ABNeon zones the bot sees (liveSupportZones);
 *   every hour the detector's status / reason changes (the live arm state, 24h arm TTL);
 *   for a qualified bounce: the touch-volume rule (touch 4H + next two not grey on aggregated volume).
 *
 * Run (from artifacts/api-server; same cache):
 *   STUDY_CG_RPM=30 pnpm dlx tsx scripts/abneon-miss-check.ts --out ../../reports/abneon-miss-check
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { evaluateAbneonSupportBounce, liveSupportZones } from "../src/lib/stealth-abneon-detectors.js";
import { cgHistory, cgStats, withVolume } from "./study-v2/cg.js";
import { D1, H1, H4, ensureDir, idxAtOrBefore, klines, lastClosed, parseArgs, welkin } from "./study-v2/lib.js";

const args = parseArgs();
const OUT = args.get("out") ?? "abneon-miss-check";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const FROM = Date.parse(args.get("from") ?? "2026-11-04T00:00:00Z");
const SYMBOLS = (args.get("symbols") ?? "KNOTS,SI,GANG,PRIORS,EDGEX").split(",").map((s) => `${s}-USDT`);
const NON_GREY = new Set(["A", "O", "M", "W", "Y"]);

const fmtT = (t: number) => {
  const d = new Date(t + 4 * H1), p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:00 Дубай`;
};
const px = (x: number | null | undefined) => (x == null ? "—" : String(+x.toPrecision(5)));

async function main() {
  const now = Math.floor(Date.now() / H1) * H1;
  ensureDir(OUT); ensureDir(CACHE);
  const out: string[] = [`ABNeon: почему пропущены отскоки · с ${fmtT(FROM)} до ${fmtT(now)}`, `Цвета объёма по агрегату фьючерсов: N серый, A синий, Y жёлтый, O оранжевый, M фиолетовый, W белый`];
  for (const symbol of SYMBOLS) {
    out.push(`\n=== ${symbol}`);
    try {
      const h4 = await klines(CACHE, symbol, "4h", FROM - 120 * D1, now);
      const h1 = await klines(CACHE, symbol, "1h", FROM - 10 * D1, now);
      const agg = await cgHistory(CACHE, symbol, "aggfut", FROM - 120 * D1, now);
      out.push(` BingX: 4H свечей ${h4.length} (с ${h4[0] ? fmtT(h4[0].time) : "—"}), 1H ${h1.length}; агрегат CoinGlass: ${agg ? `${agg.size} часов` : "НЕТ"}`);
      if (h4.length === 0 || h1.length === 0) continue;
      const a4 = withVolume(h4, agg, H4);
      let arm: { level: number; time: number } | null = null;
      let last = "";
      for (let t = Math.ceil(FROM / H1) * H1; t <= now; t += H1) {
        const i4 = lastClosed(h4, t, H4), i1 = lastClosed(h1, t, H1);
        if (i4 < 0 || i1 < 0) continue;
        if (h4[i4]!.time + H4 === t) {
          const c = h4[i4]!;
          const zones = liveSupportZones(h4.slice(Math.max(0, i4 - 639), i4 + 1)).sort((a, b) => b.top - a.top);
          out.push(` 4H ${fmtT(c.time)} O ${px(c.open)} H ${px(c.high)} L ${px(c.low)} C ${px(c.close)} · объём ${welkin(a4, i4) ?? "нет агрегата"} · зоны: ${zones.map((z) => `${px(z.bottom)}–${px(z.top)}`).join(", ") || "нет"}`);
        }
        const res = evaluateAbneonSupportBounce({
          candles4h: h4.slice(Math.max(0, i4 - 639), i4 + 1), candles1h: h1.slice(Math.max(0, i1 - 29), i1 + 1),
          observedAt: t, marketCapUsd: null, ...(arm ? { frozenLevel: arm.level, armCandleTime: arm.time } : {}), sweepReclaimBars: 3,
        });
        let extra = "";
        if (res.status === "qualified" && res.triggerCandleTime != null && res.frozenLevel != null && res.armCandleTime != null) {
          const ti = idxAtOrBefore(h1, res.triggerCandleTime);
          let w0 = ti;
          while (w0 - 1 >= 0 && h1[w0 - 1]!.time + H1 > res.armCandleTime) w0--;
          let touch = h1[Math.max(0, w0)]!.time;
          for (let k = Math.max(0, w0); k <= ti; k++) if (h1[k]!.low <= res.frozenLevel * 1.002) { touch = h1[k]!.time; break; }
          const j0 = idxAtOrBefore(h4, touch);
          const cols: string[] = [];
          for (let j = j0; j >= 0 && j <= j0 + 2 && j < h4.length; j++) { if (h4[j]!.time + H4 > t) break; cols.push(welkin(a4, j) ?? "нет"); }
          extra = ` · вход ${px(h1[ti]?.close)} · объём касания (4H касания + 2 следующие): ${cols.join(",") || "4H касания не закрыта"} → ${cols.some((x) => NON_GREY.has(x)) ? "ПРОХОДИТ" : "серый / нет агрегата — сигнала нет"}`;
          arm = null;
        } else if (res.status === "armed" && res.frozenLevel != null && res.armCandleTime != null) {
          if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime };
        } else if (arm && (res.status === "terminal" || t - arm.time > 24 * H1)) {
          arm = null;
        }
        const line = `${res.status} ${res.reason} ${px(res.frozenLevel)}`;
        if (line !== last || extra) out.push(`   ${fmtT(t)} детектор: ${res.status} · ${res.reason} · уровень ${px(res.frozenLevel)}${extra}`);
        last = line;
      }
    } catch (err) {
      out.push(` ошибка: ${String(err).slice(0, 200)}`);
    }
  }
  out.push(`\nCoinGlass: запросов ${cgStats.requests}, ok ${cgStats.ok}, пусто ${cgStats.empty}, ошибок ${cgStats.errors}, 429: ${cgStats.r429}`);
  writeFileSync(join(OUT, "miss-check.txt"), out.join("\n") + "\n");
  console.log(`строк ${out.length}`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
