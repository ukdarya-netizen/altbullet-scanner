// ── Canonical pattern label map ───────────────────────────────────────────────
// Single source of truth for all pattern display names (backend).
// Frontend mirror: artifacts/alpha-scanner/src/lib/pattern-labels.ts
// Format: {emoji} {Русское название} · {English name} #{sentimentKey}
// Both files must stay in sync — update both when adding/changing patterns.

export const PATTERN_LABELS: Record<string, string> = {
  // ── Активные паттерны и имена исторических сделок ───────────────────────────
  bullish_accumulation:
    "📊 Бычье накопление · Bullish Accum #bullish_accumulation",
  balanced_grind: "🟡 Умеренный широкий рост · Balanced Grind #balanced_grind",
  whale_watch: "🐋 Киты на фьючерсах · Whale Futures #whale_watch",
  stealth_breakout: "🔵 Stealth Breakout 🧪 эксперимент — Пробой узкого ренджа #stealth_breakout",
  neon_support_bounce:
    "🩷 Neon Support — Отскок от поддержки #neon_support_bounce",
  price_led_momentum: "💫 Цена лидирует · Spot Momentum #price_led_momentum",
  impulse_buy: "⚡ Импульсная покупка · Impulse Buy #impulse_buy",
  liquidation_cascade:
    "💥🔄 Каскад ликвидаций · Liquidation Cascade #liquidation_cascade",
  liquidation_cascade_bg:
    "💥🔄 Каскад ликвидаций [L10·фон] · Liq Cascade Job #liquidation_cascade_bg",
};

export function getPatternLabel(key: string | null | undefined): string {
  if (!key) return "—";
  return PATTERN_LABELS[key] ?? key;
}

/** Short label for Telegram — strips " #hashtag" suffix, keeps "emoji RU · EN" */
export function getPatternTgLabel(key: string | null | undefined): string {
  if (!key) return "—";
  const full = PATTERN_LABELS[key] ?? key;
  return full.split(" #")[0];
}
