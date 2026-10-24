import { db, trackedSignalsTable } from "@workspace/db";
import type { TrackedSignal } from "@workspace/db";
import { inArray, gte, lt, and } from "drizzle-orm";
import { getFutureTickers } from "./bingx.js";
import { logger } from "./logger.js";
import { getPatternTgLabel } from "./pattern-labels.js";
import {
  getBuStopTakePct,
  isActualMonetaryPnlStatus,
  normalizeClosedPnlPercent,
  summarizeRawPnlPercent,
  formatDailyPnlLine,
  type RawPnlRow,
} from "./raw-pnl.js";
import { formatOpenPositionLines } from "./watcher-formatters.js";
import { telegramReportPlainText } from "./telegram-html.js";

export { sumRawNetPnlPercent } from "./raw-pnl.js";
export type { RawPnlRow } from "./raw-pnl.js";
export { formatOpenPositionLines } from "./watcher-formatters.js";

/** Start of the current calendar month in Asia/Dubai, represented as UTC. */
export function getDubaiMonthStart(now = new Date()): Date {
  const dubaiNow = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(dubaiNow.getUTCFullYear(), dubaiNow.getUTCMonth(), 1) -
      4 * 60 * 60 * 1000,
  );
}

// Изображение, прикладываемое к сообщению об открытых позициях (все точки отправки).
export const POSITIONS_IMG = new URL(
  "../assets/active_trades.png",
  import.meta.url,
).pathname;

// ── Format helpers ─────────────────────────────────────────────────────────────

export function fmtP(p: number): string {
  if (p >= 1) return `$${p.toFixed(3)}`;
  if (p >= 0.01) return `$${p.toFixed(4)}`;
  if (p >= 0.001) return `$${p.toFixed(5)}`;
  return `$${p.toFixed(6)}`;
}

export function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

// ── Report helpers ─────────────────────────────────────────────────────────────

function fmtDateTime(): string {
  return new Date().toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDateRange(from: Date, to: Date): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
  };
  return `${from.toLocaleDateString("ru-RU", opts)}–${to.toLocaleDateString("ru-RU", opts)}`;
}

function patLabel(sentimentKey: string | null | undefined): string {
  if (!sentimentKey) return "";
  return ` [${getPatternTgLabel(sentimentKey)}]`;
}

function pnlStr(
  pnl: number | null | undefined,
  status?: string | null,
  sentimentKey?: string | null,
): string {
  if (pnl == null) return "";
  const normalizedPnl = normalizeClosedPnlPercent(status, pnl, sentimentKey);
  if (normalizedPnl == null) return "";
  return ` ${normalizedPnl >= 0 ? "+" : ""}${normalizedPnl.toFixed(1)}%`;
}

function aggregatePnl(rows: readonly TrackedSignal[]): string {
  return fmtPct(summarizeRawPnlPercent(rows).netPercent);
}

function beCountLines(rows: readonly TrackedSignal[]): string[] {
  const counts = new Map<number, number>();
  for (const row of rows) {
    const take = getBuStopTakePct(row.status, row.lastMilestone);
    const group =
      take === 5 ? 5 : take === 8 ? 8 : take != null && take >= 10 ? 10 : null;
    if (group != null) counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return ([5, 8, 10] as const).map(
    (take) => `  • после +${take}%: ${counts.get(take) ?? 0}`,
  );
}

function reportSummaryBlock(
  profits: TrackedSignal[],
  stops: TrackedSignal[],
  rawPnlRows?: readonly RawPnlRow[],
  includePnlBreakdown = false,
): string[] {
  const includeNetPnl = rawPnlRows != null;
  const total = profits.length + stops.length;
  if (total === 0 && !includeNetPnl) return [];
  const lines = [`📈 <b>Итог:</b>`];
  if (total > 0) {
    const winRate = Math.round((profits.length / total) * 100);
    const monetaryProfits = profits.filter((s) =>
      isActualMonetaryPnlStatus(s.status),
    );
    const avgProfit =
      monetaryProfits.length > 0
        ? monetaryProfits.reduce(
            (a, s) =>
              a +
              (normalizeClosedPnlPercent(
                s.status,
                s.pnlPercent,
                s.sentimentKey,
              ) ?? 0),
            0,
          ) / monetaryProfits.length
        : null;
    const avgStop =
      stops.length > 0
        ? stops.reduce(
            (a, s) =>
              a +
              (normalizeClosedPnlPercent(
                s.status,
                s.pnlPercent,
                s.sentimentKey,
              ) ?? 0),
            0,
          ) / stops.length
        : null;
    lines.push(
      `  Win rate: <b>${winRate}%</b> (${profits.length}✅ / ${stops.length}🛑)`,
    );
    if (avgProfit != null)
      lines.push(`  Средний профит: <b>+${avgProfit.toFixed(1)}%</b>`);
    if (avgStop != null)
      lines.push(`  Средний стоп: <b>${avgStop.toFixed(1)}%</b>`);
  }
  if (includeNetPnl) {
    const pnlSummary = summarizeRawPnlPercent(rawPnlRows);
    if (includePnlBreakdown) {
      lines.push(`  Профит: <b>${fmtPct(pnlSummary.profitPercent)}</b>`);
      lines.push(`  Потери: <b>${pnlSummary.lossPercent.toFixed(1)}%</b>`);
    }
    lines.push(`  Чистая прибыль: <b>${fmtPct(pnlSummary.netPercent)}</b>`);
    lines.push(
      `  <i>Σ PnL всех закрытых позиций; отмены учтены по фактическому PnL</i>`,
    );
  }
  return lines;
}

export async function buildDailyReport(): Promise<string> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [openRows, closedRows] = await Promise.all([
    db
      .select()
      .from(trackedSignalsTable)
      .where(inArray(trackedSignalsTable.status, ["active", "in_run"])),
    db
      .select()
      .from(trackedSignalsTable)
      .where(
        and(
          gte(trackedSignalsTable.closedAt, since),
          inArray(trackedSignalsTable.status, [
            "profit",
            "bu_stop",
            "breakeven",
            "expired",
            "stop_loss",
            "cancelled",
          ]),
        ),
      ),
  ]);

  const profits = closedRows.filter((s) => s.status === "profit");
  const beRows = closedRows.filter((s) =>
    ["bu_stop", "breakeven"].includes(s.status),
  );
  const expired = closedRows.filter((s) => s.status === "expired");
  const stops = closedRows.filter((s) => s.status === "stop_loss");
  const cancels = closedRows.filter((s) => s.status === "cancelled");

  const lines: string[] = [
    `📊 <b>Дневной отчёт</b> — <i>${fmtDateTime()} МСК</i>`,
    ``,
  ];

  // Open positions
  if (openRows.length > 0) {
    lines.push(`📌 <b>Открытые — ${openRows.length}:</b>`);
    for (const s of openRows) {
      const pnl =
        s.pnlPercent != null
          ? ` (текущий: ${s.pnlPercent >= 0 ? "+" : ""}${s.pnlPercent.toFixed(1)}%)`
          : "";
      lines.push(
        `  • <b>${s.symbol.replace("-USDT", "")}</b>${patLabel(s.sentimentKey)}${pnl}`,
      );
    }
    lines.push(``);
  } else {
    lines.push(`📌 Открытых позиций нет`);
    lines.push(``);
  }

  // Profit
  if (profits.length > 0) {
    lines.push(`✅ <b>Закрыты в профит — ${profits.length}:</b>`);
    for (const s of profits)
      lines.push(
        `  • <b>${s.symbol.replace("-USDT", "")}</b>${patLabel(s.sentimentKey)}${pnlStr(s.pnlPercent, s.status, s.sentimentKey)}`,
      );
    lines.push(``);
  }

  if (beRows.length > 0) {
    lines.push(
      `🛡 BE — ${beRows.length} | PnL: ${aggregatePnl(beRows)}`,
      ...beCountLines(beRows),
      ``,
    );
  }

  if (stops.length > 0) {
    lines.push(
      `🛑 Стоп-лосс — ${stops.length} | PnL: ${aggregatePnl(stops)}`,
      ``,
    );
  }

  if (expired.length > 0) {
    lines.push(`⏳ <b>Expired — ${expired.length}:</b>`);
    for (const s of expired)
      lines.push(
        `  • <b>${s.symbol.replace("-USDT", "")}</b>${patLabel(s.sentimentKey)}${pnlStr(s.pnlPercent, s.status, s.sentimentKey)}`,
      );
    lines.push(``);
  }

  if (cancels.length > 0) {
    lines.push(
      `🚫 Отменено — ${cancels.length} | PnL: ${aggregatePnl(cancels)}`,
      ``,
    );
  }

  if (
    profits.length === 0 &&
    stops.length === 0 &&
    expired.length === 0 &&
    cancels.length === 0
  ) {
    lines.push(`Закрытых сделок за последние 24ч нет.`);
    lines.push(``);
  }

  lines.push(...reportSummaryBlock(profits, stops));
  lines.push(formatDailyPnlLine(closedRows));

  return telegramReportPlainText(lines.join("\n"));
}

const PERIOD_CLOSED_STATUSES = [
  "profit",
  "bu_stop",
  "breakeven",
  "expired",
  "stop_loss",
] as const;

function beGroup(row: TrackedSignal): 5 | 8 | 10 | null {
  const take = getBuStopTakePct(row.status, row.lastMilestone);
  if (take === 5) return 5;
  if (take === 8) return 8;
  return take != null && take >= 10 ? 10 : null;
}

/**
 * Compact period report shared by weekly and monthly digests: top-3 winners,
 * then counts with PnL per outcome and the total. Only closed trades count.
 */
export function formatPeriodReport(
  rows: readonly TrackedSignal[],
  opts: {
    title: string;
    period: string;
    emptyText: string;
    hashtags: string;
  },
): string {
  const closed = rows.filter((s) =>
    (PERIOD_CLOSED_STATUSES as readonly string[]).includes(s.status),
  );
  const lines: string[] = [
    `📊 <b>${opts.title}</b> — <i>${opts.period}</i>`,
    ``,
  ];
  if (closed.length === 0) {
    lines.push(opts.emptyText, ``, opts.hashtags);
    return telegramReportPlainText(lines.join("\n"));
  }

  const pnlOf = (s: TrackedSignal) =>
    normalizeClosedPnlPercent(s.status, s.pnlPercent, s.sentimentKey) ?? 0;
  const net = (group: readonly TrackedSignal[]) =>
    fmtPct(summarizeRawPnlPercent(group).netPercent);

  const top = closed
    .filter((s) => pnlOf(s) > 0)
    .sort((a, b) => pnlOf(b) - pnlOf(a))
    .slice(0, 3);
  if (top.length > 0) {
    const medals = ["🥇", "🥈", "🥉"];
    lines.push(`🏆 <b>Топ-3 по профиту:</b>`);
    top.forEach((s, i) =>
      lines.push(
        `${medals[i]} <b>${s.symbol.replace("-USDT", "")}</b>${patLabel(s.sentimentKey)}${pnlStr(s.pnlPercent, s.status, s.sentimentKey)}`,
      ),
    );
    lines.push(``);
  }

  const profits = closed.filter((s) => s.status === "profit");
  const be = closed.filter(
    (s) => s.status === "bu_stop" || s.status === "breakeven",
  );
  const stops = closed.filter((s) => s.status === "stop_loss");
  const expired = closed.filter((s) => s.status === "expired");

  lines.push(`✅ Профит: ${profits.length} | PnL: ${net(profits)}`);
  lines.push(`❌ Стоп-лосс: ${stops.length} | PnL: ${net(stops)}`);
  lines.push(`🛡 BE: ${be.length} | PnL: ${net(be)}`);
  for (const g of [5, 8, 10] as const) {
    const grp = be.filter((s) => beGroup(s) === g);
    lines.push(`  • после +${g}%: ${grp.length} | PnL: ${net(grp)}`);
  }
  lines.push(`⏳ Expired: ${expired.length} | PnL: ${net(expired)}`);
  lines.push(``);
  lines.push(`💰 <b>Общий PnL: ${net(closed)}</b>`);
  lines.push(`Всего закрыто: ${closed.length}`);
  lines.push(``, opts.hashtags);
  return telegramReportPlainText(lines.join("\n"));
}

export function formatWeeklyDigest(
  rows: readonly TrackedSignal[],
  since: Date,
  now = new Date(),
): string {
  return formatPeriodReport(rows, {
    title: "Недельный отчёт",
    period: fmtDateRange(since, now),
    emptyText: "За последние 7 дней закрытых сделок не было.",
    hashtags: "#еженедельный_отчет #weekly_report",
  });
}

export function formatMonthlyDigest(
  rows: readonly TrackedSignal[],
  monthStart: Date,
): string {
  const monthName = monthStart.toLocaleString("ru-RU", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Dubai",
  });
  return formatPeriodReport(rows, {
    title: "Месячный отчёт",
    period: monthName,
    emptyText: "В этом месяце закрытых сделок не было.",
    hashtags: "#ежемесячный_отчет #monthly_report",
  });
}

/** Previous full calendar month in Asia/Dubai: [start, end). */
export function getPreviousDubaiMonthRange(now = new Date()): {
  start: Date;
  end: Date;
} {
  const end = getDubaiMonthStart(now);
  const start = getDubaiMonthStart(new Date(end.getTime() - 1));
  return { start, end };
}

export async function loadClosedInPeriod(
  start: Date,
  end: Date,
): Promise<TrackedSignal[]> {
  return db
    .select()
    .from(trackedSignalsTable)
    .where(
      and(
        gte(trackedSignalsTable.closedAt, start),
        lt(trackedSignalsTable.closedAt, end),
        inArray(trackedSignalsTable.status, [...PERIOD_CLOSED_STATUSES]),
      ),
    );
}

export async function buildWeeklyReport(): Promise<string> {
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return formatWeeklyDigest(await loadClosedInPeriod(since, now), since, now);
}

/** Monthly report always covers the previous full month (Asia/Dubai). */
export async function buildMonthlyDigest(): Promise<string> {
  const { start, end } = getPreviousDubaiMonthRange();
  return formatMonthlyDigest(await loadClosedInPeriod(start, end), start);
}

// ── Полный статус-текст — рестарт-уведомление, 4ч авто-апдейт, кнопка /status ─
export async function buildPositionsStatusText(): Promise<string> {
  const dbHost =
    process.env.DATABASE_URL?.match(/@([^/]+)\//)?.[1] ?? "unknown";
  let allOpen = await db
    .select()
    .from(trackedSignalsTable)
    .where(inArray(trackedSignalsTable.status, ["active", "in_run"]));

  logger.info(
    {
      count: allOpen.length,
      statuses: allOpen.map((s) => ({ symbol: s.symbol, status: s.status })),
      dbHost,
    },
    "buildPositionsStatusText: DEBUG query result",
  );

  // Если получили 0 позиций — перепроверяем через 30с.
  // Причина: под нагрузкой (первый скан 551 токена) pg-pool может вернуть пустой
  // result SET без exception вместо connection timeout. Retry отсеивает ложные нули.
  if (allOpen.length === 0) {
    await new Promise((r) => setTimeout(r, 30_000));
    allOpen = await db
      .select()
      .from(trackedSignalsTable)
      .where(inArray(trackedSignalsTable.status, ["active", "in_run"]));
    logger.info(
      {
        count: allOpen.length,
        statuses: allOpen.map((s) => ({ symbol: s.symbol, status: s.status })),
        dbHost,
      },
      "buildPositionsStatusText: DEBUG retry query result",
    );
  }

  if (allOpen.length === 0) {
    return [
      `📊 <b>Открытых позиций нет</b>`,
      ``,
      `Сканер ищет сигналы в режиме реального времени.`,
      `Сигнал придёт когда условия выполнятся.`,
    ].join("\n");
  }

  const priceMap = new Map<string, number>();
  try {
    const tickers = (await getFutureTickers()) as {
      symbol: string;
      lastPrice: string;
    }[];
    for (const t of tickers)
      priceMap.set(t.symbol, parseFloat(t.lastPrice) || 0);
  } catch {
    /* non-critical — покажем без цен */
  }

  const moscowTime = new Date().toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  return [
    `📊 <b>Открытые позиции</b> — <i>${moscowTime} МСК</i>`,
    ``,
    ...formatOpenPositionLines(allOpen, priceMap),
    `📋 Всего открытых: <b>${allOpen.length}</b> | Авто-апдейт каждые 6ч`,
  ].join("\n");
}
