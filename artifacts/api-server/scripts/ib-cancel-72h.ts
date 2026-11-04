/**
 * Owner 2026-10-29: what happened to cancelled Impulse Buy (IB) signals in the
 * 72 hours after the cancel? Are the IB cancels right?
 *
 * Input: a CSV exported from production by the SQL in the header of the owner
 * prompt (columns: id, symbol, status, cancel_reason, entry_price,
 * stop_loss_price, exit_price, pnl_percent, detected_at, closed_at).
 * Candles: public BingX 15m klines from the cancel (closed_at) for 72h.
 * Never touches a database.
 *
 * Per row, counted from the ENTRY price (what the trade would have done had it
 * stayed open):
 *  - first event after the cancel: stop (stop_loss_price, else entry -8%) or
 *    +10% from entry; within a candle the stop is counted first (conservative);
 *  - peak and low within 72h, % from entry;
 *  - price at 72h, % from entry, vs pnl at cancel.
 * A cancel is "right" when the stop came first (or nothing and 72h price is
 * below the cancel pnl) and "wrong" when +10% came first.
 *
 * Run (from artifacts/api-server): tsx scripts/ib-cancel-72h.ts <path to csv>
 */
import { readFileSync } from "node:fs";

const M15 = 15 * 60 * 1000, H72 = 72 * 60 * 60 * 1000;
type C = { time: number; high: number; low: number; close: number };

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  const split = (l: string) => {
    const out: string[] = []; let cur = "", q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur); return out;
  };
  const head = split(lines[0]!);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i]!, v])));
}

const utc = (s: string) => Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");

async function klines15m(symbol: string, start: number, end: number): Promise<C[]> {
  const out = new Map<number, C>();
  for (let cur = start; cur < end; cur += M15 * 1000) {
    const url = `https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${symbol}` +
      `&interval=15m&startTime=${cur}&endTime=${Math.min(end, cur + M15 * 1000)}&limit=1000`;
    const j = (await (await fetch(url)).json()) as { code: number; data?: Array<Record<string, string>> };
    if (j.code !== 0) throw new Error(`code ${j.code}`);
    for (const k of j.data ?? []) out.set(Number(k.time), { time: Number(k.time), high: +k.high, low: +k.low, close: +k.close });
  }
  return [...out.values()].filter((c) => c.time >= start && c.time + M15 <= end).sort((a, b) => a.time - b.time);
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: tsx scripts/ib-cancel-72h.ts <csv>");
  const rows = parseCsv(readFileSync(file, "utf8"));
  const res: Array<{ reason: string; first: "stop" | "plus10" | "none"; pnlCancel: number; peak: number; low: number; end: number; full: boolean }> = [];
  console.log("id,symbol,cancel_reason,closed_at,pnl_at_cancel,first_event,first_event_hours,peak72_pct,low72_pct,price72_pct,candles");
  for (const r of rows) {
    const entry = Number(r.entry_price);
    const exit = Number(r.exit_price);
    const t0 = utc(r.closed_at!);
    if (!(entry > 0) || !Number.isFinite(t0)) { console.log(`${r.id},${r.symbol},${r.cancel_reason},${r.closed_at},,skipped_no_entry_or_close,,,,,0`); continue; }
    const stop = Number(r.stop_loss_price) > 0 && Number(r.stop_loss_price) < entry ? Number(r.stop_loss_price) : entry * 0.92;
    const end = Math.min(t0 + H72, Date.now());
    let cs: C[] = [];
    try { cs = await klines15m(r.symbol!, Math.floor(t0 / M15) * M15 + M15, end); } catch (e) {
      console.log(`${r.id},${r.symbol},${r.cancel_reason},${r.closed_at},,error ${String(e).slice(0, 40)},,,,,0`); continue;
    }
    if (!cs.length) { console.log(`${r.id},${r.symbol},${r.cancel_reason},${r.closed_at},,no_candles,,,,,0`); continue; }
    const pct = (p: number) => (p / entry - 1) * 100;
    const pnlCancel = Number.isFinite(Number(r.pnl_percent)) && r.pnl_percent !== "" ? Number(r.pnl_percent) : pct(exit);
    let first: "stop" | "plus10" | "none" = "none", firstH = "";
    let peak = -Infinity, low = Infinity;
    for (const c of cs) {
      peak = Math.max(peak, pct(c.high)); low = Math.min(low, pct(c.low));
      if (first === "none") {
        if (c.low <= stop) { first = "stop"; firstH = ((c.time + M15 - t0) / 3.6e6).toFixed(1); }
        else if (c.high >= entry * 1.1) { first = "plus10"; firstH = ((c.time + M15 - t0) / 3.6e6).toFixed(1); }
      }
    }
    const endPct = pct(cs[cs.length - 1]!.close);
    const full = cs.length >= 280;
    res.push({ reason: r.cancel_reason || r.status || "?", first, pnlCancel, peak, low, end: endPct, full });
    console.log(`${r.id},${r.symbol},${r.cancel_reason},${r.closed_at},${pnlCancel.toFixed(2)},${first},${firstH},${peak.toFixed(2)},${low.toFixed(2)},${endPct.toFixed(2)},${cs.length}`);
    await new Promise((x) => setTimeout(x, 150));
  }
  const groups = new Map<string, typeof res>();
  for (const x of res) { groups.set("ALL", [...(groups.get("ALL") ?? []), x]); groups.set(x.reason, [...(groups.get(x.reason) ?? []), x]); }
  console.log("\nSUMMARY (from entry; right = stop first or no +10% and 72h price below cancel pnl)");
  for (const [g, xs] of groups) {
    const n = xs.length, f = (k: string) => xs.filter((x) => x.first === k).length;
    const avg = (k: "pnlCancel" | "peak" | "end") => (xs.reduce((a, x) => a + x[k], 0) / n).toFixed(2);
    const right = xs.filter((x) => x.first === "stop" || (x.first === "none" && x.end < x.pnlCancel)).length;
    console.log(`${g}: n=${n} (full 72h ${xs.filter((x) => x.full).length}) | stop first ${f("stop")} | +10% first ${f("plus10")} | neither ${f("none")} | ` +
      `cancel right ${right} (${Math.round(100 * right / n)}%) | avg pnl at cancel ${avg("pnlCancel")}% | avg peak72 ${avg("peak")}% | avg price72 ${avg("end")}%`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
