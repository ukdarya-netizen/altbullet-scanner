import { Activity, ScanSearch, Target, Terminal } from "lucide-react";
import "./_group.css";

const items = [
  { label: "Открытые позиции", sub: "мониторинг ТП / стопов", icon: Target },
  { label: "Обзор", sub: "общая статистика", icon: Activity },
  { label: "Сканер", sub: "кандидаты текущего цикла", icon: ScanSearch },
];

export function Current() {
  return (
    <div className="brand-preview-current flex min-h-screen bg-background text-foreground">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card">
        <div className="h-16 flex items-center px-6 border-b border-border">
          <Terminal className="w-5 h-5 text-primary mr-3" />
          <span className="font-bold text-lg tracking-wider text-primary">
            ALT<span className="text-foreground">BULLET</span>
          </span>
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