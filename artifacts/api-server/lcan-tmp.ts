import fs from "fs";
import { getKlinesRange } from "./src/lib/bingx.js";
const D = "/home/runner/workspace/.lctmp/";
const H = fs.readFileSync(D + "wh.txt", "utf8").split(",");
const rows = fs
  .readFileSync(D + "w.csv", "utf8")
  .trim()
  .split("\n")
  .map((l) => l.split(","));
const out: any[] = [];
async function one(r: string[]) {
  const o: any = {};
  H.forEach((h, i) => (o[h] = r[i]));
  const td = +o.t,
    t0 = Math.floor(td / 9e5) * 9e5,
    e = +o.p;
  try {
    const k = (
      await getKlinesRange(o.symbol, "15m", t0, t0 + 48 * 3600e3)
    ).filter((x) => x.time >= t0);
    if (k.length < 90) return;
    const c = k[0];
    o.range = ((+c.high - +c.low) / +c.open) * 100;
    o.wick = ((Math.min(+c.open, +c.close) - +c.low) / +c.open) * 100;
    o.body = ((+c.close - +c.open) / +c.open) * 100;
    let res = "open",
      peak = 0,
      peakBeforeSL = 0;
    for (const x of k) {
      if (res === "open") {
        if (+x.low <= e * 0.9) {
          res = "SL";
        } else {
          peakBeforeSL = Math.max(peakBeforeSL, (+x.high / e - 1) * 100);
          if (+x.high >= e * 1.1) res = "TP10";
        }
      }
      peak = Math.max(peak, (+x.high / e - 1) * 100);
    }
    o.res = res;
    o.peak = peak;
    o.pbs = peakBeforeSL;
    o.last = (+k[k.length - 1].close / e - 1) * 100;
    out.push(o);
  } catch {}
}
const q = [...rows];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (q.length) await one(q.shift()!);
  }),
);
fs.writeFileSync(D + "out.json", JSON.stringify(out));
console.log("done", out.length);
