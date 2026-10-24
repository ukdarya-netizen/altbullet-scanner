/**
 * enrich-growth-leaders.ts
 *
 * Заполняет NULL-поля в growth_leader_log для строк с price24h >= 20%:
 *   cvd_30m          — bool, SpotCVD 30m бычий (CG aggregated-cvd/history)
 *   spot_cvd_4h      — bool, SpotCVD 4h бычий (CG aggregated-cvd/history)
 *   cvd_delta_4h     — real, Δ cum_vol_delta USD за 4h (из того же endpoint)
 *   funding_rate     — real, фьючерсный funding rate (CG funding-rates-history)
 *   entry_price_24h  — real, p24h% на момент first_seen_at (CG spot OHLCV → вычисление)
 *   growth_from_entry— real, (price - entry_price)/entry_price*100 (DB-only, без API)
 *
 * Чекпоинты каждые 50 символов → /tmp/enrich-checkpoint.json
 * Финальный CSV → /tmp/growth-leaders-enriched.csv
 *
 * Запуск:
 *   DATABASE_URL=... COINGLASS_API_KEY=... COINGLASS_API_KEY_2=... tsx scripts/src/enrich-growth-leaders.ts
 */

import pg from "pg";
import fs from "fs";
import path from "path";

const { Pool } = pg;

// ── Config ────────────────────────────────────────────────────────────────────

const CHECKPOINT_PATH = "/tmp/enrich-checkpoint.json";
const CSV_PATH = "/tmp/growth-leaders-enriched.csv";
const BATCH_SIZE = 5; // символов в батче
const BATCH_DELAY_MS = 1500; // пауза между батчами
const CG_CALL_DELAY = 250; // мс между CG вызовами одного символа
const MIN_PRICE24H = 20; // порог: только строки с price24h >= 20%

// ── CoinGlass keys round-robin ────────────────────────────────────────────────

const CG_KEYS = [
  process.env.COINGLASS_API_KEY,
  process.env.COINGLASS_API_KEY_2,
  process.env.COINGLASS_API_KEY_3,
  process.env.COINGLASS_API_KEY_4,
  process.env.COINGLASS_API_KEY_5,
].filter(Boolean) as string[];

let _cgIdx = 0;
function nextCgKey(): string | null {
  if (CG_KEYS.length === 0) return null;
  return CG_KEYS[_cgIdx++ % CG_KEYS.length]!;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface CgCvdCandle {
  time: number;
  cum_vol_delta: number;
}
interface CgOhlcvBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
interface CgFundingBar {
  time: number;
  fundingRate: number;
}

async function cgFetch<T>(url: string): Promise<T[] | null> {
  const key = nextCgKey();
  if (!key) return null;
  try {
    const res = await fetch(url, {
      headers: { "CG-API-KEY": key, Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 429) {
      console.warn(`  ⚠ CG 429 key=...${key.slice(-4)}`);
      return null;
    }
    const json = (await res.json()) as { code?: string; data?: T[] };
    if (
      json.code !== "0" ||
      !Array.isArray(json.data) ||
      json.data.length === 0
    )
      return null;
    return json.data;
  } catch {
    return null;
  }
}

// ── Fetch CVD history (30m or 4h) ─────────────────────────────────────────────

async function fetchCvd(
  base: string,
  interval: "30m" | "4h",
  startMs: number,
  limit: number,
): Promise<CgCvdCandle[] | null> {
  return cgFetch<CgCvdCandle>(
    `https://open-api-v4.coinglass.com/api/spot/aggregated-cvd/history?symbol=${encodeURIComponent(base)}&interval=${interval}&start_time=${startMs}&limit=${limit}`,
  );
}

// ── Fetch funding rate history ────────────────────────────────────────────────

async function fetchFunding(
  base: string,
  startMs: number,
  limit: number,
): Promise<CgFundingBar[] | null> {
  return cgFetch<CgFundingBar>(
    `https://open-api-v4.coinglass.com/api/futures/funding-rates-history?symbol=${encodeURIComponent(base)}USDT_PERP&interval=8h&start_time=${startMs}&limit=${limit}`,
  );
}

// ── Fetch spot OHLCV history (for entry_price_24h) ────────────────────────────

async function fetchSpotOhlcv(
  base: string,
  startMs: number,
  limit: number,
): Promise<CgOhlcvBar[] | null> {
  return cgFetch<CgOhlcvBar>(
    `https://open-api-v4.coinglass.com/api/spot/ohlcv-history?exchange=Binance&symbol=${encodeURIComponent(base)}USDT&interval=1h&start_time=${startMs}&limit=${limit}`,
  );
}

// ── Compute helpers ───────────────────────────────────────────────────────────

/** Найти ближайшую свечу к timestamp ms (в пределах tolerance). */
function nearestCandle<T extends { time: number }>(
  arr: T[],
  targetMs: number,
  toleranceMs: number,
): T | null {
  let best: T | null = null;
  let bestDist = Infinity;
  for (const c of arr) {
    const d = Math.abs(c.time - targetMs);
    if (d < bestDist && d <= toleranceMs) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

/** Последняя CVD-свеча ≤ targetMs. Возвращает cum_vol_delta. */
function cvdAtOrBefore(arr: CgCvdCandle[], targetMs: number): number | null {
  let best: CgCvdCandle | null = null;
  for (const c of arr) {
    if (c.time <= targetMs) {
      if (!best || c.time > best.time) best = c;
    }
  }
  return best?.cum_vol_delta ?? null;
}

/** CVD-свеча ~= targetMs ± intervalMs. */
function cvdBullish(
  arr: CgCvdCandle[] | null,
  targetMs: number,
  intervalMs: number,
): boolean | null {
  if (!arr) return null;
  const windowStart = targetMs - intervalMs;
  const candles = arr.filter(
    (c) => c.time >= windowStart && c.time <= targetMs,
  );
  if (candles.length < 2) return null;
  candles.sort((a, b) => a.time - b.time);
  const first = candles[0]!.cum_vol_delta;
  const last = candles[candles.length - 1]!.cum_vol_delta;
  return last > first;
}

/** Δ cum_vol_delta за intervalMs заканчивающийся в targetMs. */
function cvdDeltaUsd(
  arr: CgCvdCandle[] | null,
  targetMs: number,
  intervalMs: number,
): number | null {
  if (!arr || arr.length < 2) return null;
  const before = cvdAtOrBefore(arr, targetMs - intervalMs);
  const after = cvdAtOrBefore(arr, targetMs);
  if (before == null || after == null) return null;
  return after - before;
}

/** Funding rate на момент targetMs — ближайшая запись ≤ targetMs + 8h. */
function fundingAtTime(
  arr: CgFundingBar[] | null,
  targetMs: number,
): number | null {
  if (!arr) return null;
  return nearestCandle(arr, targetMs, 8 * 3_600_000)?.fundingRate ?? null;
}

/**
 * entry_price_24h:
 * Цена 24ч ДО first_seen_at из OHLCV, потом: (entry_price - price24hBefore) / price24hBefore * 100
 */
function calcEntryPrice24h(
  ohlcv: CgOhlcvBar[] | null,
  firstSeenMs: number,
  entryPrice: number | null,
): number | null {
  if (!ohlcv || !entryPrice || entryPrice <= 0) return null;
  const target24hBefore = firstSeenMs - 24 * 3_600_000;
  const bar = nearestCandle(ohlcv, target24hBefore, 2 * 3_600_000);
  if (!bar || bar.close <= 0) return null;
  return ((entryPrice - bar.close) / bar.close) * 100;
}

// ── DB row type ───────────────────────────────────────────────────────────────

interface GllRow {
  id: number;
  symbol: string;
  logged_at: Date;
  first_seen_at: number | null;
  price: number | null;
  price24h: number | null;
  entry_price: number | null;
  cvd_30m: boolean | null;
  spot_cvd_4h: boolean | null;
  cvd_delta_4h: number | null;
  funding_rate: number | null;
  entry_price_24h: number | null;
  growth_from_entry: number | null;
  // all other columns — kept for CSV output
  [key: string]: unknown;
}

// ── Checkpoint ────────────────────────────────────────────────────────────────

interface Checkpoint {
  doneSymbols: string[];
  processedRows: number;
}

function loadCheckpoint(): Checkpoint {
  try {
    if (fs.existsSync(CHECKPOINT_PATH)) {
      const c = JSON.parse(
        fs.readFileSync(CHECKPOINT_PATH, "utf8"),
      ) as Checkpoint;
      console.log(
        `📂 Чекпоинт загружен: ${c.doneSymbols.length} символов уже обработано`,
      );
      return c;
    }
  } catch {
    /* ignore */
  }
  return { doneSymbols: [], processedRows: 0 };
}

function saveCheckpoint(cp: Checkpoint): void {
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

function toCsvValue(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCsvHeader(headers: string[]): void {
  fs.writeFileSync(CSV_PATH, headers.join(",") + "\n", "utf8");
}

function appendCsvRows(
  rows: Record<string, unknown>[],
  headers: string[],
): void {
  const lines = rows.map((r) => headers.map((h) => toCsvValue(r[h])).join(","));
  fs.appendFileSync(CSV_PATH, lines.join("\n") + "\n", "utf8");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 enrich-growth-leaders: старт");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  // 1. Load rows needing enrichment
  console.log(
    `📥 Загружаем строки с price24h >= ${MIN_PRICE24H}% и NULL-полями...`,
  );
  const { rows: allRows } = await pool.query<GllRow>(
    `
    SELECT *
    FROM growth_leader_log
    WHERE price_24h >= $1
      AND (
        cvd_30m          IS NULL OR
        spot_cvd_4h      IS NULL OR
        cvd_delta_4h     IS NULL OR
        funding_rate     IS NULL OR
        entry_price_24h  IS NULL OR
        growth_from_entry IS NULL
      )
    ORDER BY logged_at
  `,
    [MIN_PRICE24H],
  );

  console.log(
    `  → ${allRows.length} строк, ${new Set(allRows.map((r) => r.symbol)).size} символов`,
  );

  if (allRows.length === 0) {
    console.log("✅ Нечего заполнять");
    await pool.end();
    return;
  }

  // 2. Group by symbol
  const bySymbol = new Map<string, GllRow[]>();
  for (const row of allRows) {
    const sym = row.symbol;
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    bySymbol.get(sym)!.push(row);
  }
  const symbols = [...bySymbol.keys()];

  // 3. Load checkpoint
  const cp = loadCheckpoint();
  const doneSet = new Set(cp.doneSymbols);

  // 4. Prepare CSV header from first row
  const allCols = Object.keys(allRows[0]!);
  writeCsvHeader(allCols);

  // 5. Process in batches
  const todo = symbols.filter((s) => !doneSet.has(s));
  console.log(
    `  → ${todo.length} символов к обработке (${doneSet.size} уже в чекпоинте)`,
  );

  let processedSymbols = 0;
  let updatedRows = 0;
  let skippedSymbols = 0;

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);

    for (const sym of batch) {
      const rows = bySymbol.get(sym)!;
      const base = sym.replace("-USDT", "");
      const minTs = Math.min(...rows.map((r) => r.logged_at.getTime()));
      const maxTs = Math.max(...rows.map((r) => r.logged_at.getTime()));
      const firstSeen =
        rows.find((r) => r.first_seen_at != null)?.first_seen_at ?? null;

      console.log(
        `  [${i + processedSymbols + 1}/${todo.length}] ${base} (${rows.length} строк)`,
      );

      // CG window: от minTs-48h до maxTs+1h, +запас
      const cgStart = minTs - 48 * 3_600_000;
      const cgLimit = Math.ceil((maxTs - cgStart) / (30 * 60_000)) + 20; // 30m свечей

      // ── Fetch all CG data ────────────────────────────────────────────────────
      let cvd30mHist: CgCvdCandle[] | null = null;
      let cvd4hHist: CgCvdCandle[] | null = null;
      let fundingHist: CgFundingBar[] | null = null;
      let ohlcvHist: CgOhlcvBar[] | null = null;

      try {
        cvd30mHist = await fetchCvd(
          base,
          "30m",
          cgStart,
          Math.min(cgLimit, 200),
        );
        await delay(CG_CALL_DELAY);

        cvd4hHist = await fetchCvd(
          base,
          "4h",
          cgStart,
          Math.min(Math.ceil(cgLimit / 8) + 10, 100),
        );
        await delay(CG_CALL_DELAY);

        fundingHist = await fetchFunding(base, cgStart, 50);
        await delay(CG_CALL_DELAY);

        // For entry_price_24h: fetch OHLCV around first_seen_at - 26h to first_seen_at + 2h
        if (firstSeen != null) {
          const ohlcvStart = firstSeen - 26 * 3_600_000;
          ohlcvHist = await fetchSpotOhlcv(base, ohlcvStart, 30);
          await delay(CG_CALL_DELAY);
        }
      } catch (err) {
        console.warn(`  ⚠ ${base}: CG fetch error: ${err}`);
        skippedSymbols++;
        continue;
      }

      // ── Compute per-row ──────────────────────────────────────────────────────
      const updates: Array<{
        id: number;
        cvd_30m: boolean | null;
        spot_cvd_4h: boolean | null;
        cvd_delta_4h: number | null;
        funding_rate: number | null;
        entry_price_24h: number | null;
        growth_from_entry: number | null;
      }> = [];

      const enrichedRows: Record<string, unknown>[] = [];

      for (const row of rows) {
        const ts = row.logged_at.getTime();

        const new_cvd_30m =
          row.cvd_30m ?? cvdBullish(cvd30mHist, ts, 30 * 60_000);
        const new_cvd_4h =
          row.spot_cvd_4h ?? cvdBullish(cvd4hHist, ts, 4 * 3_600_000);
        const new_cvd_delta =
          row.cvd_delta_4h ?? cvdDeltaUsd(cvd4hHist, ts, 4 * 3_600_000);
        const new_funding = row.funding_rate ?? fundingAtTime(fundingHist, ts);

        const new_entry_p24h =
          row.entry_price_24h ??
          calcEntryPrice24h(
            ohlcvHist,
            row.first_seen_at ?? ts,
            row.entry_price,
          );

        const new_growth =
          row.growth_from_entry ??
          (row.price != null && row.entry_price != null && row.entry_price > 0
            ? ((row.price - row.entry_price) / row.entry_price) * 100
            : null);

        updates.push({
          id: row.id,
          cvd_30m: new_cvd_30m,
          spot_cvd_4h: new_cvd_4h,
          cvd_delta_4h: new_cvd_delta,
          funding_rate: new_funding,
          entry_price_24h: new_entry_p24h,
          growth_from_entry: new_growth,
        });

        enrichedRows.push({
          ...row,
          cvd_30m: new_cvd_30m,
          spot_cvd_4h: new_cvd_4h,
          cvd_delta_4h: new_cvd_delta,
          funding_rate: new_funding,
          entry_price_24h: new_entry_p24h,
          growth_from_entry: new_growth,
        });
      }

      // ── DB UPDATE ────────────────────────────────────────────────────────────
      const hasAnyData = updates.some(
        (u) =>
          u.cvd_30m != null ||
          u.spot_cvd_4h != null ||
          u.cvd_delta_4h != null ||
          u.funding_rate != null ||
          u.entry_price_24h != null ||
          u.growth_from_entry != null,
      );

      if (hasAnyData) {
        const vals = updates
          .map((u, idx) => {
            const base_idx = idx * 7;
            return `($${base_idx + 1}::int, $${base_idx + 2}::boolean, $${base_idx + 3}::boolean, $${base_idx + 4}::real, $${base_idx + 5}::real, $${base_idx + 6}::real, $${base_idx + 7}::real)`;
          })
          .join(", ");

        const params: unknown[] = updates.flatMap((u) => [
          u.id,
          u.cvd_30m,
          u.spot_cvd_4h,
          u.cvd_delta_4h,
          u.funding_rate,
          u.entry_price_24h,
          u.growth_from_entry,
        ]);

        try {
          await pool.query(
            `
            UPDATE growth_leader_log AS t
            SET
              cvd_30m           = COALESCE(t.cvd_30m,           v.cvd30),
              spot_cvd_4h       = COALESCE(t.spot_cvd_4h,       v.cvd4h),
              cvd_delta_4h      = COALESCE(t.cvd_delta_4h,      v.cvddelta),
              funding_rate      = COALESCE(t.funding_rate,       v.funding),
              entry_price_24h   = COALESCE(t.entry_price_24h,   v.ep24h),
              growth_from_entry = COALESCE(t.growth_from_entry, v.growth)
            FROM (VALUES ${vals})
              AS v(id, cvd30, cvd4h, cvddelta, funding, ep24h, growth)
            WHERE t.id = v.id
          `,
            params,
          );
          updatedRows += updates.length;
          console.log(`    ✓ DB обновлено: ${updates.length} строк`);
        } catch (err) {
          console.warn(`    ✗ DB update error: ${err}`);
        }
      } else {
        console.log(`    — нет данных от CG (BingX-exclusive?)`);
        skippedSymbols++;
      }

      // Append to CSV immediately (progress-safe)
      appendCsvRows(enrichedRows, allCols);
      processedSymbols++;
    }

    // Checkpoint every 50 symbols (or end of batch)
    const totalDone = [...doneSet, ...todo.slice(0, i + BATCH_SIZE)];
    cp.doneSymbols = totalDone;
    cp.processedRows = updatedRows;
    saveCheckpoint(cp);

    const pct = Math.round(((i + BATCH_SIZE) / todo.length) * 100);
    console.log(
      `📊 Прогресс: ${Math.min(i + BATCH_SIZE, todo.length)}/${todo.length} символов (${pct}%) | обновлено строк: ${updatedRows}`,
    );

    if (i + BATCH_SIZE < todo.length) await delay(BATCH_DELAY_MS);
  }

  await pool.end();

  console.log(`\n✅ Готово:`);
  console.log(`   Обработано символов:  ${processedSymbols}`);
  console.log(`   Обновлено строк в DB: ${updatedRows}`);
  console.log(`   Пропущено (нет CG):   ${skippedSymbols}`);
  console.log(`   CSV: ${CSV_PATH}`);

  // Remove checkpoint on success
  try {
    fs.unlinkSync(CHECKPOINT_PATH);
  } catch {
    /* ok */
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
