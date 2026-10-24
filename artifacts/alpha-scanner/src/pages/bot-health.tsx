import { useEffect, useState } from "react";
import {
  useGetBotHealth,
  getGetBotHealthQueryKey,
} from "@workspace/api-client-react";
import type { BotHealthStatus } from "@workspace/api-client-react";

// ─── helpers ──────────────────────────────────────────────────────────────────

type StatusLevel = "ok" | "warn" | "crit" | "unknown";

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtMin(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}мин` : `${(m / 60).toFixed(1)}ч`;
}

function fmtAge(ts: number | null | undefined): string {
  if (ts == null) return "никогда";
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}с назад`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}мин назад`;
  return `${Math.floor(mins / 60)}ч назад`;
}

function fmtIso(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtIsoAge(iso: string | null | undefined): string {
  if (!iso) return "—";
  return fmtAge(new Date(iso).getTime());
}

function statusColor(level: StatusLevel): string {
  if (level === "ok") return "text-green-400";
  if (level === "warn") return "text-yellow-400";
  if (level === "crit") return "text-red-400";
  return "text-zinc-500";
}

function statusDot(level: StatusLevel): string {
  if (level === "ok") return "bg-green-500";
  if (level === "warn") return "bg-yellow-400";
  if (level === "crit") return "bg-red-500";
  return "bg-zinc-600";
}

function statusLabel(level: StatusLevel): string {
  if (level === "ok") return "OK";
  if (level === "warn") return "WARN";
  if (level === "crit") return "CRIT";
  return "—";
}

function cgTimeoutLevel(pct: number): StatusLevel {
  if (pct < 10) return "ok";
  if (pct < 30) return "warn";
  return "crit";
}

function cgP95Level(ms: number): StatusLevel {
  if (ms < 3000) return "ok";
  if (ms < 8000) return "warn";
  return "crit";
}

function elLagLevel(ms: number): StatusLevel {
  if (ms < 100) return "ok";
  if (ms < 500) return "warn";
  return "crit";
}

function dbPingLevel(ms: number | null | undefined): StatusLevel {
  if (ms == null) return "unknown";
  if (ms < 50) return "ok";
  if (ms < 200) return "warn";
  return "crit";
}

function jobLevel(intervalMs: number, overdueMs: number | null): StatusLevel {
  if (overdueMs === null) return "unknown"; // never ran
  if (overdueMs === 0) return "ok";
  if (overdueMs < intervalMs * 0.5) return "warn";
  return "crit";
}

function deliveryLevel(status: string, queueClass: string): StatusLevel {
  if (queueClass === "historical") return "warn";
  if (status === "ambiguous" || status === "abandoned") return "crit";
  if (status === "retry" || status === "processing") return "warn";
  return "ok";
}

function deliveryStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    ready: "в очереди",
    retry: "повтор в очереди",
    processing: "в обработке",
    ambiguous: "исход неизвестен",
    abandoned: "явный отказ",
  };
  return labels[status] ?? status;
}

function deliveryReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    timeout: "timeout",
    network: "сеть",
    telegram_5xx: "Telegram 5xx",
    explicit_429: "Telegram 429",
    explicit_rejection: "явный отказ",
    bounded_recovery: "ограниченный recovery",
    persisted_send_fence: "рестарт / fence",
    unknown: "неизвестно",
  };
  return labels[reason] ?? reason;
}

// ─── sub-components ───────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-mono tracking-widest text-primary/60 uppercase mb-3 border-b border-border pb-1">
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  level,
}: {
  label: string;
  value: React.ReactNode;
  level?: StatusLevel;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/40 last:border-0 text-xs">
      <span className="text-muted-foreground font-mono">{label}</span>
      <span
        className={`font-mono font-medium ${level ? statusColor(level) : "text-foreground"}`}
      >
        {value}
      </span>
    </div>
  );
}

function ConnectionRow({
  label,
  ok,
}: {
  label: string;
  ok: boolean | null | undefined;
}) {
  const level: StatusLevel =
    ok === true ? "ok" : ok === false ? "crit" : "unknown";
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/40 last:border-0 text-xs">
      <span className="text-muted-foreground font-mono">{label}</span>
      <span className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${statusDot(level)}`} />
        <span className={`font-mono font-medium ${statusColor(level)}`}>
          {statusLabel(level)}
        </span>
      </span>
    </div>
  );
}

function GaugeBar({
  value,
  max,
  level,
}: {
  value: number;
  max: number;
  level: StatusLevel;
}) {
  const pct = Math.min(100, (value / max) * 100);
  const barColor =
    level === "ok"
      ? "bg-green-500"
      : level === "warn"
        ? "bg-yellow-400"
        : "bg-red-500";
  return (
    <div className="w-full h-1 bg-zinc-800 rounded-none overflow-hidden mt-1">
      <div
        className={`h-full transition-all ${barColor}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function JobRow({
  job,
}: {
  job: {
    label: string;
    intervalMs: number;
    lastRunAt: number | null;
    overdueMs: number | null;
  };
}) {
  const level = jobLevel(job.intervalMs, job.overdueMs);
  const overdueDisplay =
    job.overdueMs === null
      ? "—"
      : job.overdueMs === 0
        ? "в норме"
        : `+${fmtMs(job.overdueMs)}`;

  return (
    <div className="py-2 border-b border-border/40 last:border-0">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot(level)}`}
          />
          <span className="text-xs font-mono text-foreground">{job.label}</span>
        </div>
        <span className={`text-xs font-mono font-medium ${statusColor(level)}`}>
          {statusLabel(level)}
          {job.overdueMs != null && job.overdueMs > 0 && (
            <span className="ml-1 text-zinc-500">({overdueDisplay})</span>
          )}
        </span>
      </div>
      <div className="flex items-center justify-between mt-0.5 pl-3.5">
        <span className="text-[10px] text-zinc-600 font-mono">
          последний: {fmtAge(job.lastRunAt ?? undefined)}
        </span>
        <span className="text-[10px] text-zinc-600 font-mono">
          интервал: {fmtMin(job.intervalMs)}
        </span>
      </div>
      {job.overdueMs !== null && (
        <div className="pl-3.5 mt-1">
          <GaugeBar
            value={Math.min(job.overdueMs, job.intervalMs)}
            max={job.intervalMs}
            level={level}
          />
        </div>
      )}
    </div>
  );
}

// ─── main ─────────────────────────────────────────────────────────────────────

const JOB_ORDER = [
  "fastCycle",
  "liqCascade",
  "watcherCycle",
  "price24hRefresh",
  "backfill",
];

type SendState = "idle" | "loading" | "ok" | "err";

function getAdminAuthHeader(): Record<string, string> {
  return {
    Authorization: `Bearer ${localStorage.getItem("authToken") ?? ""}`,
  };
}

async function sendReport(path: string): Promise<boolean> {
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: getAdminAuthHeader(),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function ReportButton({ label, path }: { label: string; path: string }) {
  const [state, setState] = useState<SendState>("idle");
  const handle = async () => {
    setState("loading");
    const ok = await sendReport(path);
    setState(ok ? "ok" : "err");
    setTimeout(() => setState("idle"), 4000);
  };
  const bg =
    state === "ok"
      ? "bg-green-600 border-green-500"
      : state === "err"
        ? "bg-red-600 border-red-500"
        : state === "loading"
          ? "bg-zinc-700 border-zinc-600 opacity-60"
          : "bg-zinc-800 border-zinc-600 hover:bg-zinc-700";
  return (
    <button
      onClick={handle}
      disabled={state === "loading"}
      className={`px-4 py-2 text-xs font-mono border transition-colors text-white ${bg}`}
    >
      {state === "loading"
        ? "Отправка…"
        : state === "ok"
          ? "✓ Отправлено"
          : state === "err"
            ? "✗ Ошибка"
            : label}
    </button>
  );
}

export default function BotHealth() {
  const [now, setNow] = useState(Date.now());

  const { data, isLoading, dataUpdatedAt } = useGetBotHealth({
    query: {
      queryKey: getGetBotHealthQueryKey(),
      refetchInterval: 15_000,
    },
  });

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const d = data as BotHealthStatus | undefined;

  const cg = d?.cgLatency;
  const conn = d?.connections;
  const sc = d?.scanner;
  const db = d?.db;
  const oiW = d?.oiWatch;
  const jobs = d?.jobs ?? {};
  const deliveries = d?.telegramDeliveries ?? [];

  if (isLoading && !d) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm font-mono">
        Загрузка...
      </div>
    );
  }

  const scanAgeMs = sc?.lastScanAt
    ? now - new Date(sc.lastScanAt).getTime()
    : null;
  const scannerLevel: StatusLevel = !sc?.running
    ? "crit"
    : sc.isScanning
      ? "warn"
      : scanAgeMs != null && scanAgeMs > 40 * 60_000
        ? "crit"
        : scanAgeMs != null && scanAgeMs > 20 * 60_000
          ? "warn"
          : "ok";

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-mono text-muted-foreground">
            SYSTEM HEALTH MONITOR
          </h2>
          {dataUpdatedAt > 0 && (
            <p className="text-[10px] text-zinc-600 font-mono mt-0.5">
              обновлено: {new Date(dataUpdatedAt).toLocaleTimeString("ru-RU")}
              &nbsp;·&nbsp;авто-обновление 15с
            </p>
          )}
        </div>
        <OverallBadge data={d} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {/* ── Scanner ── */}
        <div className="bg-card border border-border p-4">
          <SectionTitle>Scanner Core</SectionTitle>
          <Row
            label="Статус"
            level={scannerLevel}
            value={
              !sc?.running ? "STOPPED" : sc.isScanning ? "SCANNING…" : "IDLE"
            }
          />
          <Row
            label="Последний скан"
            value={fmtIso(sc?.lastScanAt)}
            level={
              scanAgeMs == null
                ? "unknown"
                : scanAgeMs > 40 * 60_000
                  ? "crit"
                  : scanAgeMs > 20 * 60_000
                    ? "warn"
                    : "ok"
            }
          />
          <Row label="Следующий скан" value={fmtIso(sc?.nextScanAt)} />
          <Row
            label="Длительность"
            value={
              sc?.lastScanDurationMs != null
                ? fmtMs(sc.lastScanDurationMs)
                : "—"
            }
            level={
              sc?.lastScanDurationMs == null
                ? "unknown"
                : sc.lastScanDurationMs < 15 * 60_000
                  ? "ok"
                  : sc.lastScanDurationMs < 25 * 60_000
                    ? "warn"
                    : "crit"
            }
          />
          <Row label="Рынков отсканировано" value={sc?.marketsScanned ?? "—"} />
          <Row
            label="Интервал"
            value={sc?.scanIntervalMs != null ? fmtMin(sc.scanIntervalMs) : "—"}
          />
        </div>

        {/* ── CoinGlass Latency ── */}
        <div className="bg-card border border-border p-4">
          <SectionTitle>CoinGlass Latency</SectionTitle>
          {!cg ? (
            <div className="text-xs text-zinc-500 font-mono py-4 text-center">
              Нет данных (первый скан не завершён)
            </div>
          ) : (
            <>
              <Row
                label="Timeout %"
                level={cgTimeoutLevel(cg.timeoutPct)}
                value={`${cg.timeoutPct}%`}
              />
              <div className="pb-1">
                <GaugeBar
                  value={cg.timeoutPct}
                  max={100}
                  level={cgTimeoutLevel(cg.timeoutPct)}
                />
              </div>
              <Row
                label="p50"
                value={fmtMs(cg.p50Ms)}
                level={cgP95Level(cg.p50Ms)}
              />
              <Row
                label="p95"
                value={fmtMs(cg.p95Ms)}
                level={cgP95Level(cg.p95Ms)}
              />
              <div className="pb-1">
                <GaugeBar
                  value={cg.p95Ms}
                  max={10_000}
                  level={cgP95Level(cg.p95Ms)}
                />
              </div>
              <Row label="Max" value={fmtMs(cg.maxMs)} />
              <Row
                label="Event Loop p95"
                value={fmtMs(cg.elLagP95Ms)}
                level={elLagLevel(cg.elLagP95Ms)}
              />
              <Row
                label="Запросов/мин"
                value={`${cg.reqPerMin} (${cg.req} всего)`}
              />
              <Row
                label="Окно наблюдения"
                value={`${cg.windowMin.toFixed(1)} мин`}
              />
            </>
          )}
        </div>

        {/* ── Critical Telegram Delivery ── */}
        <div className="bg-card border border-border p-4">
          <SectionTitle>Telegram delivery</SectionTitle>
          <p className="text-[10px] text-zinc-600 font-mono mb-2">
            API accepted ≠ пользователь прочитал сообщение
          </p>
          {deliveries.length === 0 ? (
            <div className="text-xs text-green-400 font-mono py-4 text-center">
              Нет очередей или событий для внимания
            </div>
          ) : (
            <div className="space-y-2">
              {deliveries.map((delivery, index) => {
                const level = deliveryLevel(
                  delivery.status,
                  delivery.queueClass,
                );
                return (
                  <div
                    key={`${delivery.recipientRole}:${delivery.status}:${delivery.reason}:${index}`}
                    className="border-b border-border/40 pb-2 last:border-0"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono text-foreground">
                        {deliveryStatusLabel(delivery.status)}
                      </span>
                      <span
                        className={`text-xs font-mono ${statusColor(level)}`}
                      >
                        {delivery.rows}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <span className="text-[10px] text-zinc-600 font-mono">
                        {delivery.recipientRole === "channel"
                          ? "канал"
                          : "личные чаты"}{" "}
                        · {deliveryReasonLabel(delivery.reason)}
                        {delivery.queueClass === "historical"
                          ? " · архив"
                          : " · активная очередь"}
                      </span>
                      <span className="text-[10px] text-zinc-600 font-mono">
                        от {fmtIsoAge(delivery.oldestAt)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Connections ── */}
        <div className="bg-card border border-border p-4">
          <SectionTitle>API Connections</SectionTitle>
          <ConnectionRow label="BingX" ok={conn?.bingx} />
          <ConnectionRow label="Telegram" ok={conn?.telegram} />
          <ConnectionRow label="CoinGlass" ok={conn?.coinglass} />
          <ConnectionRow label="Coinalyze" ok={conn?.coinalyze} />
          <ConnectionRow label="CoinGecko" ok={conn?.coinGecko} />
          <ConnectionRow label="CoinPaprika" ok={conn?.coinPaprika} />

          {/* DB ping */}
          <div className="mt-3 pt-3 border-t border-border/60">
            <SectionTitle>Database (Neon)</SectionTitle>
            <Row
              label="Ping"
              value={db?.ok ? fmtMs(db.pingMs) : "FAIL"}
              level={db?.ok === false ? "crit" : dbPingLevel(db?.pingMs)}
            />
            {db?.ok && db.pingMs != null && (
              <GaugeBar
                value={db.pingMs}
                max={300}
                level={dbPingLevel(db.pingMs)}
              />
            )}
          </div>

          {/* OI Watch */}
          {oiW && (
            <div className="mt-3 pt-3 border-t border-border/60">
              <SectionTitle>OI Watch</SectionTitle>
              <Row
                label="Ошибки INS"
                value={oiW.insertErrors}
                level={
                  oiW.insertErrors === 0
                    ? "ok"
                    : oiW.insertErrors < 5
                      ? "warn"
                      : "crit"
                }
              />
              <Row
                label="CG таймауты (скан)"
                value={oiW.cgTimeoutsLastScan}
                level={
                  oiW.cgTimeoutsLastScan === 0
                    ? "ok"
                    : oiW.cgTimeoutsLastScan < 10
                      ? "warn"
                      : "crit"
                }
              />
            </div>
          )}
        </div>

        {/* ── Background Jobs ── */}
        <div className="bg-card border border-border p-4 md:col-span-2 xl:col-span-3">
          <SectionTitle>Background Jobs</SectionTitle>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            {JOB_ORDER.filter((k) => jobs[k]).map((key) => (
              <JobRow key={key} job={jobs[key]} />
            ))}
            {JOB_ORDER.filter((k) => jobs[k]).length === 0 && (
              <div className="col-span-4 text-xs text-zinc-500 font-mono py-2 text-center">
                Данные появятся после первого запуска каждого джоба
              </div>
            )}
          </div>
        </div>

        {/* ── Admin Actions ── */}
        <div className="bg-card border border-border p-4 md:col-span-2 xl:col-span-3">
          <SectionTitle>Отчёты</SectionTitle>
          <div className="flex flex-wrap gap-3 mt-2">
            <ReportButton
              label="📊 Отправить недельный дайджест"
              path="/api/scanner/reports/send-weekly"
            />
            <ReportButton
              label="📋 Отправить дневной отчёт"
              path="/api/scanner/reports/send-daily"
            />
            <ReportButton
              label="📆 Отправить месячный отчёт"
              path="/api/tracker/monthly-digest"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── overall status badge ─────────────────────────────────────────────────────

function OverallBadge({ data }: { data: BotHealthStatus | undefined }) {
  if (!data) {
    return (
      <span className="px-3 py-1.5 text-xs font-mono bg-zinc-800 text-zinc-500 border border-zinc-700">
        LOADING
      </span>
    );
  }

  const levels: StatusLevel[] = [];

  const sc = data.scanner;
  const cg = data.cgLatency;
  const jobs = data.jobs ?? {};

  levels.push(sc.running ? "ok" : "crit");
  if (cg) {
    levels.push(cgTimeoutLevel(cg.timeoutPct));
    levels.push(cgP95Level(cg.p95Ms));
    levels.push(elLagLevel(cg.elLagP95Ms));
  }
  levels.push(data.db.ok ? dbPingLevel(data.db.pingMs) : "crit");
  data.telegramDeliveries.forEach((delivery) => {
    levels.push(deliveryLevel(delivery.status, delivery.queueClass));
  });
  Object.values(jobs).forEach((j) => {
    if (j.lastRunAt !== null) levels.push(jobLevel(j.intervalMs, j.overdueMs));
  });

  const overall: StatusLevel = levels.includes("crit")
    ? "crit"
    : levels.includes("warn")
      ? "warn"
      : "ok";

  const bg =
    overall === "ok"
      ? "bg-green-500/10 border-green-500/30 text-green-400"
      : overall === "warn"
        ? "bg-yellow-400/10 border-yellow-400/30 text-yellow-300"
        : "bg-red-500/10 border-red-500/30 text-red-400";

  return (
    <span
      className={`px-3 py-1.5 text-xs font-mono font-bold border ${bg} tracking-widest`}
    >
      {overall === "ok"
        ? "● ALL SYSTEMS OK"
        : overall === "warn"
          ? "◐ DEGRADED"
          : "● CRITICAL"}
    </span>
  );
}
