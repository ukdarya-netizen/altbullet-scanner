// Our signals with every metric as a CSV file (owner 2026-11-04: analysis on our own signals, by name).
// «;» between columns and a decimal comma, so it opens as a table in Excel / Numbers.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Coverage = {
  days: number;
  patterns: Array<{ key: string; total: number; vsa: number; vsa_with_volume: number; wyckoff: number; extras?: number | null; colors?: number | null }>;
  failedNow: number;
  reasons: Record<string, number>;
  extrasFailedNow?: number;
  extrasReasons?: Record<string, number>;
  colorsFailedNow?: number;
  colorsReasons?: Record<string, number>;
  restoreOnly?: boolean;
  restoreEnv?: string;
  loops?: Record<string, { mode: string; passes: number; lastPassAt: string | null; lastTried: number; lastWritten: number; running: boolean; lastError: string | null }>;
};
const NAMES: Record<string, string> = {
  impulse_buy: "Impulse Buy", stealth_breakout: "Stealth", neon_support_bounce: "ABNeon", liquidation_cascade: "Liquidation Cascade",
};

/** VSA and Wyckoff at the entry: how many signals already have them (restored in the background). */
function CoverageLine() {
  const q = useQuery({
    queryKey: ["signals-export-coverage"],
    queryFn: async () => {
      const r = await fetch(`${API_BASE}/api/signals-export/coverage`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("authToken") ?? ""}` },
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(`HTTP ${r.status}${body?.error ? ` — ${body.error}` : ""}`);
      }
      return (await r.json()) as Coverage;
    },
    refetchInterval: 60_000,
  });
  if (q.error) return <p className="text-xs text-destructive">VSA / Вайкофф: не удалось проверить ({(q.error as Error).message})</p>;
  const d = q.data;
  if (!d) return null;
  return (
    <div className="text-xs space-y-1">
      {d.restoreOnly && (
        <p className="font-semibold text-destructive">
          Режим восстановления (CAB_RESTORE_ONLY=1): сканер и быстрый цикл ОСТАНОВЛЕНЫ — новых сигналов нет, открытые позиции не ведутся. Когда VSA, Вайкофф и параметры пробоя/IB дойдут до числа сигналов — удалите Secret CAB_RESTORE_ONLY и опубликуйте.
        </p>
      )}
      <p className="font-semibold">VSA, Вайкофф и параметры пробоя / IB на входе за {d.days} дней (восстанавливаются в фоне по одному сигналу: сначала IB и Stealth, потом ABNeon и LC):</p>
      {d.patterns.map((p) => (
        <p key={p.key} className="tabular-nums">
          {NAMES[p.key] ?? p.key}: сигналов {p.total} · VSA {p.vsa} · Вайкофф {p.wyckoff}
          {p.extras !== null && p.extras !== undefined ? ` · параметры ${p.key === "impulse_buy" ? "IB" : "пробоя"} ${p.extras}` : ""}
          {p.colors !== null && p.colors !== undefined ? ` · цвета объёма 48ч ${p.colors}` : ""}
        </p>
      ))}
      {!d.restoreOnly && <p className="font-semibold">Режим восстановления: ВЫКЛЮЧЕН — сервер видит CAB_RESTORE_ONLY: {d.restoreEnv ?? "нет данных"}. Сканер работает.</p>}
      {Object.keys(d.loops ?? {}).length === 0 && <p className="font-semibold text-destructive">Очереди восстановления на этом сервере НЕ запущены.</p>}
      {Object.entries(d.loops ?? {}).map(([name, l]) => (
        <p key={name} className="tabular-nums">
          Очередь «{name}» ({l.mode}): проходов {l.passes}{l.running ? " · идёт проход" : ""} · последний проход {l.lastPassAt ? new Date(l.lastPassAt).toLocaleTimeString() : "ещё не закончен"} · взято {l.lastTried}, записано {l.lastWritten}{l.lastError ? ` · ошибка: ${l.lastError}` : ""}
        </p>
      ))}
      {d.failedNow > 0 && (
        <p className="text-muted-foreground">
          Не получилось сейчас: {d.failedNow} — {Object.entries(d.reasons).map(([r, n]) => `${r}: ${n}`).join(" · ")}. Повтор: без объёма CoinGlass — через 30 минут, остальное — через 6 часов.
        </p>
      )}
      {(d.colorsFailedNow ?? 0) > 0 && (
        <p className="text-muted-foreground">
          Цвета объёма не получились сейчас: {d.colorsFailedNow} — {Object.entries(d.colorsReasons ?? {}).map(([r, n]) => `${r}: ${n}`).join(" · ")}.
        </p>
      )}
      {(d.extrasFailedNow ?? 0) > 0 && (
        <p className="text-muted-foreground">
          Параметры пробоя / IB не получились сейчас: {d.extrasFailedNow} — {Object.entries(d.extrasReasons ?? {}).map(([r, n]) => `${r}: ${n}`).join(" · ")}. Повтор: сбой CoinGlass — через 30 минут, остальное — через 6 часов.
        </p>
      )}
    </div>
  );
}

export default function SignalsExportButton() {
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState<string | null>(null);
  const run = async () => {
    setStatus("Готовлю файл…");
    try {
      const r = await fetch(`${API_BASE}/api/signals-export?days=${days}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("authToken") ?? ""}` },
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(`HTTP ${r.status}${body?.error ? ` — ${body.error}` : ""}`);
      }
      const d = (await r.json()) as { columns: string[]; rows: unknown[][] };
      const cell = (v: unknown) => {
        if (v === null || v === undefined) return "";
        const t = typeof v === "number" ? String(v).replace(".", ",") : String(v);
        return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      };
      const csv = "﻿" + [d.columns, ...d.rows].map((row) => row.map(cell).join(";")).join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      a.download = `cab-signals-${days}d-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus(`Скачано: ${d.rows.length} сигналов`);
    } catch (e) {
      setStatus(`Не удалось: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-2">
      <h2 className="text-sm font-semibold">Наши сигналы с метриками (CSV)</h2>
      <p className="text-xs text-muted-foreground">
        Каждый сигнал всех паттернов: статус, пик и худшее движение (в том числе у открытых), стоп, результат и все метрики в момент сигнала — объёмы, OI, VSA, Вайкофф.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {[7, 14, 30, 60].map((n) => (
          <button key={n} type="button" onClick={() => setDays(n)}
            className={`h-9 rounded border px-3 text-xs ${days === n ? "border-primary bg-primary/10 font-semibold" : "border-border"}`}>{n} дней</button>
        ))}
        <button type="button" onClick={() => void run()} disabled={status === "Готовлю файл…"}
          className="h-9 rounded bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-50">Скачать</button>
        {status && <span className="text-xs text-muted-foreground">{status}</span>}
      </div>
      <CoverageLine />
      <StealthExitSim />
    </section>
  );
}

const VARIANT_NAMES: Record<string, string> = {
  current: "Сейчас (стоп −8%, БУ +8%, трейлинг с +15%)",
  range_in: "Выход: часовая свеча закрылась внутри диапазона",
  range_mid: "Выход: часовая свеча закрылась ниже середины диапазона",
  range_mid2: "Выход: две часовые свечи подряд ниже середины",
  be3: "Безубыток с +3%",
  be5: "Безубыток с +5%",
  part5: "Половина на +5%, остаток с безубытком",
};
type SimSummary = { variant: string; trades: number; sum: number; firstHalf: number; secondHalf: number; stops: number; rangeExits: number; atLeast5: number; losses: number };
type SimState = { status: string; done: number; total: number; error: string | null; summary: SimSummary[] | null; rows: Record<string, unknown>[] | null; variants: string[] };

/** Stealth exit variants on our signals (owner 2026-11-05). */
function StealthExitSim() {
  const [sim, setSim] = useState<SimState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const headers = { Authorization: `Bearer ${localStorage.getItem("authToken") ?? ""}` };
  const poll = async () => {
    const r = await fetch(`${API_BASE}/api/signals-export/stealth-exit-sim`, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = (await r.json()) as SimState;
    setSim(d);
    if (d.status === "running") setTimeout(() => void poll().catch((e) => setErr(String(e))), 4000);
  };
  const start = async () => {
    setErr(null);
    try {
      const r = await fetch(`${API_BASE}/api/signals-export/stealth-exit-sim?days=30`, { method: "POST", headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setTimeout(() => void poll().catch((e) => setErr(String(e))), 1500);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const download = () => {
    if (!sim?.rows?.length) return;
    const cols = [...new Set(sim.rows.flatMap((r) => Object.keys(r)))];
    const cell = (v: unknown) => {
      if (v === null || v === undefined) return "";
      const t = typeof v === "number" ? String(v).replace(".", ",") : String(v);
      return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const csv = "\ufeff" + [cols, ...sim.rows.map((r) => cols.map((c) => r[c]))].map((row) => row.map(cell).join(";")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `stealth-exit-sim-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <h3 className="text-sm font-semibold">Stealth: варианты выхода на наших сигналах (30 дней)</h3>
      <p className="text-xs text-muted-foreground">
        Каждый сигнал Stealth (пробой 1H) прогоняется по 15-минутным свечам BingX 4 дня после входа: внутри свечи первым проверяется стоп, комиссия 0,1% на сделку. Итог в таблице — только сигналы, которые пропускает фильтр Welkin; в файле — все, с пометкой.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void start()} disabled={sim?.status === "running"}
          className="h-9 rounded bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-50">Посчитать</button>
        {sim?.status === "running" && <span className="text-xs text-muted-foreground">Считаю: {sim.done} из {sim.total}</span>}
        {sim?.status === "done" && <button type="button" onClick={download} className="h-9 rounded border border-border px-3 text-xs">Скачать по сигналам (CSV)</button>}
        {(err || sim?.error) && <span className="text-xs text-destructive">Ошибка: {err ?? sim?.error}</span>}
      </div>
      {sim?.summary && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2">Вариант</th><th className="pr-2">Сделок</th><th className="pr-2">Сумма %</th><th className="pr-2">1-я половина</th><th className="pr-2">2-я половина</th><th className="pr-2">Стопов −8%</th><th className="pr-2">Выходов из диапазона</th><th className="pr-2">≥ +5%</th><th>В минус</th></tr></thead>
            <tbody>
              {sim.summary.map((x) => (
                <tr key={x.variant} className="border-t border-border/50">
                  <td className="py-1 pr-2">{VARIANT_NAMES[x.variant] ?? x.variant}</td>
                  <td className="pr-2">{x.trades}</td><td className="pr-2 font-semibold">{x.sum}</td><td className="pr-2">{x.firstHalf}</td><td className="pr-2">{x.secondHalf}</td>
                  <td className="pr-2">{x.stops}</td><td className="pr-2">{x.rangeExits}</td><td className="pr-2">{x.atLeast5}</td><td>{x.losses}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
