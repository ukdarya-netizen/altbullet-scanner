import { cn } from "@/lib/utils";
import { getLang, setLang, type Lang } from "@/lib/i18n";

const OPTIONS: { lang: Lang; label: string; title: string }[] = [
  { lang: "ru", label: "RU", title: "Русский" },
  { lang: "en", label: "EN", title: "English" },
];

/** RU / EN switch; choosing a language reloads the page. */
export function LanguageToggle({ className }: { className?: string }) {
  const current = getLang();
  return (
    <div
      data-testid="language-toggle"
      className={cn(
        "inline-flex items-center rounded-md border border-border bg-card/60 p-0.5 text-xs font-semibold",
        className,
      )}
    >
      {OPTIONS.map((o) => (
        <button
          key={o.lang}
          type="button"
          aria-pressed={current === o.lang}
          title={o.title}
          onClick={() => {
            if (current !== o.lang) setLang(o.lang);
          }}
          className={cn(
            "rounded px-2 py-1 leading-none transition-colors",
            current === o.lang
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
