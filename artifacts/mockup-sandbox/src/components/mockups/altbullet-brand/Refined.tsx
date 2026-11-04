import { Activity, ScanSearch, Target } from "lucide-react";
import "./_group.css";

const items = [
  { label: "Открытые позиции", sub: "мониторинг ТП / стопов", icon: Target },
  { label: "Обзор", sub: "общая статистика", icon: Activity },
  { label: "Сканер", sub: "кандидаты текущего цикла", icon: ScanSearch },
];

function Bullet() {
  return (
    <span aria-hidden="true" className="inline-flex size-9 shrink-0 items-center justify-center border border-cyan-300/20 bg-[#101322]">
      <svg viewBox="0 0 48 48" fill="none" className="size-[78%]">
        <defs>
          <linearGradient id="preview-metal" x1="13" y1="32" x2="39" y2="10" gradientUnits="userSpaceOnUse">
            <stop stopColor="#864DDC" /><stop offset=".42" stopColor="#5FCDF2" /><stop offset=".72" stopColor="#E2F5FF" /><stop offset="1" stopColor="#56E9B7" />
          </linearGradient>
          <linearGradient id="preview-body" x1="10" y1="33" x2="30" y2="16" gradientUnits="userSpaceOnUse">
            <stop stopColor="#542D96" /><stop offset=".52" stopColor="#143D77" /><stop offset="1" stopColor="#73DCF0" />
          </linearGradient>
        </defs>
        <path d="M4 42 15 31M9 44l8-9" stroke="#A86CE5" strokeWidth="1.7" strokeLinecap="round" />
        <path d="m12 28 17-17c3-3 7.2-4.3 12-5-1 4.8-2 9-5 12L19 35l-7-7Z" fill="url(#preview-body)" stroke="url(#preview-metal)" strokeWidth="1.5" />
        <path d="m17 30 20-20M22 33l16-16" stroke="#97E4F4" strokeOpacity=".7" strokeWidth="1.25" strokeLinecap="round" />
        <path d="m11 27 9 9-3 3-9-9 3-3Z" fill="#35305F" stroke="#AC74EC" strokeWidth="1.2" />
        <path d="m39 7 3-2-1 4" fill="#D9FFF0" />
      </svg>
    </span>
  );
}

export function Refined() {
  return (
    <div className="brand-preview-refined flex min-h-screen bg-background text-foreground">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card">
        <div className="h-16 flex items-center px-5 border-b border-border bg-[linear-gradient(110deg,rgba(85,64,154,.10),transparent_70%)]">
          <div className="inline-flex items-center gap-3 text-left" aria-label="Crypto Alt Bullet">
            <Bullet />
            <span aria-hidden="true" className="flex flex-col leading-none">
              <span className="mb-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#9BAAC5]">Crypto</span>
              <span className="whitespace-nowrap text-[17px] font-bold tracking-[0.035em] text-foreground"><span className="text-[#67D9EC]">Alt</span> Bullet</span>
            </span>
          </div>
        </div>
        <nav className="flex-1 py-4 px-3 space-y-0.5">
          {items.map(({ label, sub, icon: Icon }, i) => (
            <div key={label} className={`flex items-start px-3 py-2.5 text-sm font-medium border ${i === 1 ? "bg-primary/10 text-primary border-primary/20" : "text-muted-foreground border-transparent"}`}>
              <Icon className="w-4 h-4 mr-3 mt-0.5 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span>{label}</span>
                <span className={`text-xs font-normal ${i === 1 ? "text-primary/60" : "text-muted-foreground/60"}`}>{sub}</span>
              </div>
            </div>
          ))}
        </nav>
      </aside>
      <main className="flex-1">
        <header className="h-16 flex items-center px-8 border-b border-border bg-card/50">
          <h1 className="text-xl font-semibold">Обзор</h1>
        </header>
        <div className="p-8">
          <div className="border border-border bg-card p-5 text-sm text-muted-foreground">Общая статистика</div>
        </div>
      </main>
    </div>
  );
}