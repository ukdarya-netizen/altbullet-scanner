// ── Canonical pattern label map ───────────────────────────────────────────────
// Single source of truth for all pattern display names (frontend mirror).
// Backend source: artifacts/api-server/src/lib/pattern-labels.ts
// Format: {emoji} {Русское название} · {English name} #{sentimentKey}
// Both files must stay in sync — update both when adding/changing patterns.

// ── Active patterns — currently firing in the scanner ─────────────────────────
export const ACTIVE_PATTERN_KEYS: string[] = [
  "liquidation_cascade",
  "stealth_breakout",
  "neon_support_bounce",
  "impulse_buy",
];

// Retired patterns remain visible only where historical monthly records exist.
// Includes preserved decommissioned keys, which must never be cleaned up.
export const RETIRED_PATTERN_KEYS: string[] = [
  "bullish_accumulation",
  "balanced_grind",
  "price_led_momentum",
  "unknown",
  "anomaly",
  "mexc_pump",
  "aggressive_breakout",
  "bear_trap",
  "distribution",
  "short_squeeze",
  "silent_whale",
  "whale_position",
  "whale_onchain",
  "dip_accumulation",
  "spot_trend_accumulation",
  "spot_divergence",
  "quiet_oi_accumulation",
  "volume_taker",
  "spot_absorption",
  "accumulation_breakout",
  "early_vol_oi",
  "spot_oi4h_build",
  "spot_taker_lead",
  "spot_vol_breakout",
  "spot_momentum_reversal",
  "spot_vol_surge",
  "ob_stack_accumulation",
  "ob_smart_accumulation",
  "trend_accumulation",
  "impulse_breakout",
  "flush_reversal",
  "bid_wall_absorption",
  "liq_magnet_squeeze",
  "exchange_outflow_accum",
  "oversold_reversal",
  "smart_money_divergence",
  "4h_momentum",
  "oi1h_breakout",
  "oi4h_silent_accum",
  "quiet_trend_rider",
  "bearish_pressure",
  "volume_breakout",
  "volume_breakout_spot",
  "volume_breakout_futures",
  "volume_breakout_quiet",
  "volume_breakout_mover",
  "oi24h_accumulation",
  "daily_oi_accum_experiment",
  "bingx_exclusive",
  "whale_watch",
  "whale_futures",
  "whale_futures_early",
  "whale_watch_spot",
  "hidden_accumulation",
  "whale_alert",
  "4h_pullback_continuation",
  "spot_vol_accumulation",
  "demark",
];

export const PATTERN_LABELS: Record<string, string> = {
  // ── Active and legacy-compatible labels ───────────────────────────────────
  bullish_accumulation:
    "📊 Бычье накопление · Bullish Accum #bullish_accumulation",
  balanced_grind: "🟡 Умеренный широкий рост · Balanced Grind #balanced_grind",
  stealth_breakout: "🔵 Stealth Breakout 🧪 эксперимент — Пробой 4H-ренджа #stealth_breakout",
  neon_support_bounce:
    "🩷 Neon Support — Отскок от поддержки #neon_support_bounce",
  price_led_momentum:
    "💫 Цена лидирует без OI · Price Led Momentum #price_led_momentum",
  impulse_buy: "⚡ Импульсная покупка · Impulse Buy #impulse_buy",
  liquidation_cascade:
    "💥🔄 Каскад ликвидаций · Liquidation Cascade #liquidation_cascade",
  whale_watch: "🐋 Киты на фьючерсах · Whale Futures #whale_watch",
  liquidation_cascade_bg:
    "💥🔄 Каскад ликвидаций [L10·фон] · Liq Cascade Job #liquidation_cascade_bg",
};

export const STEALTH_PATTERN_TG_LABEL =
  "🔵 Stealth Breakout 🧪 эксперимент — Пробой 4H-ренджа";

export function getPatternLabel(key: string | null | undefined): string {
  if (!key) return "—";
  return PATTERN_LABELS[key] ?? key;
}

/** Short label for Telegram — strips " #hashtag" suffix. */
export function getPatternTgLabel(key: string | null | undefined): string {
  if (!key) return "—";
  if (key === "stealth_breakout") return STEALTH_PATTERN_TG_LABEL;
  const full = PATTERN_LABELS[key] ?? key;
  return full.split(" #")[0];
}

/** Badge label for UI — emoji + Russian name only, no English suffix, no hashtag */
export function getPatternBadgeLabel(key: string | null | undefined): string {
  if (!key) return "—";
  if (key === "stealth_breakout") return STEALTH_PATTERN_TG_LABEL;
  const full = PATTERN_LABELS[key] ?? key;
  return full.split(" · ")[0].split(" #")[0];
}
