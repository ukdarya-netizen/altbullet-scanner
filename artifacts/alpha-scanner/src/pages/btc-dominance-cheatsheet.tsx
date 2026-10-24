const scenarios = [
  { dominance: "вверх", btc: "вверх", alts: "вниз" },
  { dominance: "вверх", btc: "вниз", alts: "дамп" },
  { dominance: "вверх", btc: "флэт", alts: "флэт" },
  { dominance: "вниз", btc: "вверх", alts: "памп" },
  { dominance: "вниз", btc: "вниз", alts: "флэт" },
  { dominance: "вниз", btc: "флэт", alts: "вверх" },
] as const;

function directionColor(value: string) {
  switch (value) {
    case "вверх":
      return "text-yellow-300";
    case "вниз":
    case "дамп":
      return "text-red-400";
    case "памп":
      return "text-green-400";
    default:
      return "text-muted-foreground";
  }
}

export function BtcDominanceCheatsheet() {
  return (
    <section
      className="mt-5 border-t border-border/50 pt-4"
      aria-label="Шпаргалка по доминации BTC и цене BTC"
    >
      <h3 className="text-sm font-semibold">
        Шпаргалка: доминация BTC + BTC → альткоины
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Условные сценарии из шпаргалки, не прогноз для каждой монеты.
      </p>
      <ul className="mt-3 grid gap-2 lg:grid-cols-2">
        {scenarios.map(({ dominance, btc, alts }) => (
          <li
            key={`${dominance}-${btc}`}
            className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1 rounded-md border border-border/40 bg-background/30 px-2 py-2 text-center text-xs sm:gap-2 sm:px-3 sm:text-sm"
          >
            <span className="min-w-0">
              <span className="text-muted-foreground">BTC.D </span>
              <strong className={directionColor(dominance)}>{dominance}</strong>
            </span>
            <span className="text-muted-foreground" aria-hidden="true">
              +
            </span>
            <span className="min-w-0">
              <span className="text-muted-foreground">BTC </span>
              <strong className={directionColor(btc)}>{btc}</strong>
            </span>
            <span className="text-muted-foreground" aria-hidden="true">
              =
            </span>
            <span className="min-w-0">
              <span className="text-muted-foreground">Альты </span>
              <strong className={directionColor(alts)}>{alts}</strong>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
