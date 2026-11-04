/**
 * Canonical list of deleted / dead pattern keys.
 *
 * ACTIVE_PATTERN_KEYS — единственный разрешённый набор для пользовательской
 *                        аналитики. Всё, что не входит сюда, остаётся в БД для
 *                        аудита, но не влияет на актуальные метрики.
 * DEAD_PATTERN_KEYS   — используется для очистки БД (signals + tracked_signals).
 *                       Также разрешает показывать фактическую legacy-историю
 *                       только в месячном архиве статистики.
 *                       НЕ включает активные паттерны (liquidation_cascade и др.).
 *
 * PDB_HIDDEN_PATTERN_KEYS — DEAD_PATTERN_KEYS + паттерны которые стреляют из
 *                           background-джоба и никогда не появляются в
 *                           pattern_debug_log. Используется для фильтрации UI.
 *
 * Добавляй новые активные или мёртвые паттерны ТОЛЬКО сюда. Не создавай
 * отдельных списков в router/lib файлах.
 */

export const ACTIVE_PATTERN_KEYS = [
  "liquidation_cascade",
  "stealth_breakout",
  "neon_support_bounce",
  "impulse_buy",
] as const;

/**
 * Retired patterns whose rows must remain in the database for audit and for
 * completing positions that were already open when the pattern was disabled.
 * Unlike DEAD_PATTERN_KEYS, this list must never drive destructive cleanup.
 */
export const PRESERVED_DECOMMISSIONED_PATTERN_KEYS = [
  "bullish_accumulation",
  "balanced_grind",
  "whale_watch",
  "price_led_momentum",
] as const;

export function isPreservedDecommissionedPattern(
  pattern: string | null | undefined,
): boolean {
  return (
    pattern != null &&
    (PRESERVED_DECOMMISSIONED_PATTERN_KEYS as readonly string[]).includes(
      pattern,
    )
  );
}

export function resolveExplicitOiWatchPattern(
  payloadPattern: string | null | undefined,
  rowPattern: string | null | undefined,
): string | null {
  return payloadPattern ?? rowPattern ?? null;
}

export const DEAD_PATTERN_KEYS = [
  // ── Удалены до 2026-07 ────────────────────────────────────────────────────
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
  // ── Spot-driven эксперименты ──────────────────────────────────────────────
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
  // ── Удалены 2026-07-18 / bactest 0 сигналов ──────────────────────────────
  "impulse_breakout",
  "flush_reversal",
  "bid_wall_absorption",
  // ── Удалены 2026-07-19 ────────────────────────────────────────────────────
  "liq_magnet_squeeze",
  "exchange_outflow_accum",
  "oversold_reversal",
  "smart_money_divergence",
  "4h_momentum",
  "oi1h_breakout",
  "oi4h_silent_accum",
  "quiet_trend_rider",
  "bearish_pressure",
  // ── Volume breakout семейство (заменены SVA/VBS) ──────────────────────────
  "volume_breakout",
  "volume_breakout_spot",
  "volume_breakout_futures",
  "volume_breakout_quiet",
  "volume_breakout_mover",
  // ── OI-accumulation эксперименты ──────────────────────────────────────────
  "oi24h_accumulation",
  "daily_oi_accum_experiment",
  // ── Удалены 2026-07-20 ────────────────────────────────────────────────────
  "bingx_exclusive",
  // ── Whale variants ────────────────────────────────────────────────────────
  "whale_futures",
  "whale_futures_early",
  "whale_watch_spot",
  "hidden_accumulation",
  // ── Удалены 2026-07-27 ────────────────────────────────────────────────────
  "whale_alert",
  // ── Удалены 2026-08-01 ────────────────────────────────────────────────────
  "4h_pullback_continuation",
  // ── Удалены 2026-08-08 ────────────────────────────────────────────────────
  "spot_vol_accumulation",
  // ── Удалены 2026-08-15 ────────────────────────────────────────────────────
  "demark",
] as const;

/**
 * Паттерны которые не появляются в pattern_debug_log — для фильтрации UI.
 * Включает все мёртвые паттерны + фоновые паттерны без PDB-записей.
 */
export const PDB_HIDDEN_PATTERN_KEYS: readonly string[] = [
  ...DEAD_PATTERN_KEYS,
  // Активные, но стреляют из background-джоба → нет PDB-записей
  "liquidation_cascade",
] as const;
