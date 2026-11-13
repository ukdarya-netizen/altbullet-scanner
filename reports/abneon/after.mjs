// ABNeon after the exit (owner 2026-11-13): what did price do after the stops, cancellations, neutral closes and
// break-even closes? Read-only: reads reports/abneon/signals.csv, BingX public 1h candles (no key), writes
// reports/abneon/after.csv. Run: node reports/abneon/after.mjs
import { readFileSync, writeFileSync } from "node:fs";

function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; } else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...data] = rows;
  return data.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const H = 3_600_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function klines(symbol, start, end) {
  const out = [];
  for (let from = start; from < end; from += 500 * H) {
    const url = `https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${symbol}&interval=1h&startTime=${from}&endTime=${Math.min(end, from + 500 * H)}&limit=500`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url); const j = await r.json();
        if (Array.isArray(j.data)) { for (const k of j.data) out.push({ t: +k.time, h: +k.high, l: +k.low, c: +k.close }); break; }
      } catch { /* retry */ }
      await sleep(1000);
    }
    await sleep(250);
  }
  return [...new Map(out.map((k) => [k.t, k])).values()].sort((a, b) => a.t - b.t);
}
const pct = (a, b) => (a / b - 1) * 100;
const r2 = (v) => (v == null || !Number.isFinite(v) ? "" : v.toFixed(2));

const S = parseCsv(readFileSync("reports/abneon/signals.csv", "utf8"))
  .filter((s) => ["stop_loss", "cancelled", "reclassified", "bu_stop", "expired"].includes(s.status));
const cols = ["id", "symbol", "status", "cancel_reason", "detected_at", "exit_at", "entry", "exit", "stop",
  "after_exit_max_up_24h", "after_exit_max_up_72h", "after_exit_max_down_72h", "after_exit_close_24h", "after_exit_close_72h",
  "back_to_entry_h", "entry_peak_7d", "entry_trough_7d", "hit_plus8_before_stop", "hours_to_plus8"];
const lines = [cols.join(",")];
let n = 0;
for (const s of S) {
  const entry = +s.entry_price, det = Date.parse(s.detected_at);
  const exitAt = s.closed_at ? Date.parse(s.closed_at) : null;
  const exit = s.exit_price ? +s.exit_price : null;
  const stop = s.stop_loss_price ? +s.stop_loss_price : null;
  const end = Math.min(Date.now(), det + 7 * 24 * H + 3 * 24 * H);
  const k = await klines(s.symbol, Math.floor(det / H) * H, end);
  const after = (from, hours) => k.filter((x) => x.t >= from && x.t < from + hours * H);
  let a = {};
  if (exitAt && exit) {
    const w24 = after(exitAt, 24), w72 = after(exitAt, 72);
    const back = k.find((x) => x.t >= exitAt && x.h >= entry);
    a = {
      after_exit_max_up_24h: w24.length ? pct(Math.max(...w24.map((x) => x.h)), exit) : null,
      after_exit_max_up_72h: w72.length ? pct(Math.max(...w72.map((x) => x.h)), exit) : null,
      after_exit_max_down_72h: w72.length ? pct(Math.min(...w72.map((x) => x.l)), exit) : null,
      after_exit_close_24h: w24.length >= 24 ? pct(w24[23].c, exit) : null,
      after_exit_close_72h: w72.length >= 72 ? pct(w72[71].c, exit) : null,
      back_to_entry_h: back ? (back.t - exitAt) / H : null,
    };
  }
  const w7 = after(det, 7 * 24);
  let hit = null, hrs = null;
  for (const x of w7) {
    if (stop && x.l <= stop) { hit = false; break; }
    if (x.h >= entry * 1.08) { hit = true; hrs = (x.t - det) / H; break; }
  }
  const row = { id: s.id, symbol: s.symbol, status: s.status, cancel_reason: s.cancel_reason, detected_at: s.detected_at,
    exit_at: s.closed_at, entry, exit: exit ?? "", stop: stop ?? "",
    ...Object.fromEntries(Object.entries(a).map(([kk, v]) => [kk, typeof v === "number" ? r2(v) : v ?? ""])),
    entry_peak_7d: w7.length ? r2(pct(Math.max(...w7.map((x) => x.h)), entry)) : "",
    entry_trough_7d: w7.length ? r2(pct(Math.min(...w7.map((x) => x.l)), entry)) : "",
    hit_plus8_before_stop: hit === null ? "" : hit, hours_to_plus8: hrs ?? "" };
  lines.push(cols.map((c) => { const v = row[c] ?? ""; return String(v).includes(",") ? `"${v}"` : v; }).join(","));
  if (++n % 20 === 0) console.log(`${n}/${S.length}`);
}
writeFileSync("reports/abneon/after.csv", lines.join("\n") + "\n");
console.log(`after.csv: ${lines.length - 1} rows`);
