// Our signals with every metric as a CSV file (owner 2026-11-04: analysis on our own signals, by name).
// «;» between columns and a decimal comma, so it opens as a table in Excel / Numbers.
import { useState } from "react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SignalsExportButton() {
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState<string | null>(null);
  const run = async () => {
    setStatus("Готовлю файл…");
    try {
      const r = await fetch(`${API_BASE}/api/signals-export?days=${days}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("authToken") ?? ""}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
    </section>
  );
}
