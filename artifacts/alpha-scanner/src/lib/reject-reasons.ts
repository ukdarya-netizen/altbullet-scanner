/** Единый русский словарь причин отказа. Код остаётся только в title. */
export const REJECT_LABELS: Record<string, string> = {
  // Range / Stealth Breakout
  armed_waiting_later_1h_cross: "Ждёт пробоя 1H-свечой",
  armed_fire_in_flight: "Сигнал выдаётся сейчас",
  armed_claim_lost_or_expired: "Захват сигнала потерян или истёк",
  armed_expired: "Взвод истёк",
  armed_structure_consumed: "Структура уже отработана",
  breakout_candle_not_impulse: "Свеча пробоя слабая (тело/бычья)",
  breakout_entry_window_elapsed: "Окно входа после пробоя истекло",
  breakout_rejected_below_level: "Пробой отвергнут: цена ниже уровня",
  breakout_active_waiting_retest: "Пробой идёт, ждёт ретеста",
  breakout_active_waiting_1h_data: "Ждёт данных 1H",
  breakout_active_waiting_30m_data: "Ждёт данных 30m",
  inside_wider_active_range: "Цена всё ещё внутри более широкого диапазона",
  qualified_fire_gate_closed: "Пробой подтверждён, но выдача сигнала закрыта",
  qualified_live_fire_paused: "Пробой подтверждён, но живая выдача остановлена",
  qualified_broadcast_window_conflict:
    "Пробой подтверждён, но окно рассылки занято",
  qualified_duplicate_active_position:
    "Пробой подтверждён, но позиция по токену уже открыта",
  qualified_event_missing: "Пробой подтверждён, но событие не найдено",
  qualified_signal_insert_failed: "Не удалось записать сигнал",
  qualified_signal_insert_nonretryable_error:
    "Не удалось записать сигнал (без повтора)",
  qualified_signal_insert_retryable_error:
    "Не удалось записать сигнал (будет повтор)",
  qualified_tracker_persist_failed: "Не удалось сохранить позицию в трекере",
  qualified_tracker_persist_retryable_error:
    "Не удалось сохранить позицию (будет повтор)",
  armed_qualified_paused:
    "Пробой подтверждён, но вход остановлен (причина не записана)",
  qualified_unfired_retry_window_elapsed:
    "Пробой подтверждён, но вход не состоялся за окно ожидания",
  range_4h_insufficient_history_not_requested: "Мало истории для 4H диапазона",
  range_1h_candles_not_fresh: "1H-свечи устарели",
  range_1h_no_confirmed_range: "Нет подтверждённого 1H-диапазона",
  range_1h_replay_unknown: "Повторный расчёт 1H-диапазона не дал результата",
  range_already_broken_deviation: "Диапазон уже пробит (выход за границу)",
  range_not_confirmed_by_recheck: "Диапазон не подтверждён повторным расчётом",
  range_recheck_unavailable: "Повторный расчёт диапазона недоступен",
  range_too_tall: "Диапазон слишком высокий",
  range_width_below_threshold: "Диапазон слишком узкий",
  breakout_4h_base_volume_over_prior_mean:
    "Базовый объём 4H выше среднего предыдущих",
  insufficient_30m_context_for_fire: "Мало 30m-контекста для выдачи",
  insufficient_30m_klines: "Мало 30m-свечей",
  aggregated_data_unavailable: "Нет агрегированных данных",
  aggregated_volume_unavailable: "Нет агрегированного объёма",
  // ABNeon (Neon Support) / Order Block
  awaiting_later_1h_reaction: "Ждёт 1H-реакции у поддержки",
  awaiting_later_1h_order_block_reaction: "Ждёт 1H-реакции у OB",
  later_closed_1h_bullish_reaction: "1H-реакция подтверждена",
  later_closed_1h_order_block_reaction: "1H-реакция у OB подтверждена",
  reaction_window_expired: "Окно 1H-реакции истекло",
  support_invalidated_before_reaction: "Поддержка пробита до реакции",
  support_broken_before_entry: "Поддержка пробита до входа",
  support_not_reached: "Цена не дошла до поддержки",
  no_retested_support: "Нет поддержки с ретестами",
  srv2_touch_without_reaction: "Касание поддержки без реакции",
  srv2_unavailable: "Данные поддержки недоступны",
  missing_frozen_order_block_evidence: "Нет зафиксированных данных блока (OB)",
  order_block_invalidated_below_zone: "OB пробит ниже зоны",
  insufficient_closed_candles: "Мало закрытых свечей",
  signal_persistence_claimed: "Сигнал захвачен для записи",
  // Общие гейты других паттернов
  oi1h_low: "OI 1ч слишком мал",
  oi30m_low: "OI 30м слишком мал",
  prev_oi30m_low: "Предыдущий OI 30м слишком мал",
  oi_low: "OI слишком мал",
  oi_high: "OI слишком высок",
  oi30m_not_recovered: "OI 30м не восстановился",
  oi1h_falling: "OI 1ч падает",
  prev_oi_not_flush: "Прошлый OI не был сбросом",
  rsi1h_high: "RSI 1ч слишком высок",
  price3h_low: "Рост за 3ч слишком мал",
  price3h_high: "Рост за 3ч слишком велик",
  price4h_low: "Рост за 4ч слишком мал",
  price24h_range: "Изменение за 24ч вне диапазона",
  price24h_high: "Рост за 24ч слишком велик",
  vol4h_low: "Объём 4ч слишком мал",
  spot_vol_low: "Спот-объём слишком мал",
  cg_no_data_low: "Нет данных CoinGlass",
  no_pool_row: "Нет строки в пуле",
  not_in_pool: "Токена нет в пуле",
  not_exhausted: "Ликвидации не исчерпаны",
  taker_bearish: "Тейкеры медвежьи",
  cvd_bearish: "CVD медвежий",
  crowd_long: "Толпа в лонгах",
  deepNeg: "Слишком глубокое падение",
  stalePump: "Устаревший памп",
};

const PREFIXES: Array<[string, string]> = [
  [
    "qualified_range_recheck_blocked",
    "Пробой подтверждён, но диапазон не совпал с повторным расчётом Pine",
  ],
  ["armed_awaiting_later_1h_auto_range_breakout", "Ждёт пробоя 1H-диапазона"],
  ["armed_awaiting_later_4h_cross", "Ждёт закрытия 4H-свечи выше уровня"],
  [
    "armed_awaiting_later_1h_cross_with_volume",
    "Ждёт закрытия 1H-свечи выше уровня с объёмом",
  ],
];

/** Возвращает русский текст и исходный код (для title). */
export function rejectReason(code: string | null | undefined): {
  text: string;
  title: string;
  known: boolean;
} {
  const raw = (code ?? "").trim();
  if (!raw) return { text: "—", title: "", known: true };
  const base = raw.split(":")[0]!;
  const suffix = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : "";
  const hit =
    REJECT_LABELS[raw] ??
    REJECT_LABELS[base] ??
    PREFIXES.find(([p]) => base.startsWith(p))?.[1];
  if (hit) {
    return {
      text:
        suffix && !PREFIXES.some(([p]) => base.startsWith(p))
          ? `${hit}: ${suffix}`
          : hit,
      title: raw,
      known: true,
    };
  }
  // Уже читаемый текст (кириллица или пробелы) показываем как есть.
  if (/[А-Яа-яЁё]/.test(raw) || /\s/.test(raw)) {
    return { text: raw, title: raw, known: true };
  }
  return {
    text: "Причина отказа (без описания)",
    title: `Неизвестный код: ${raw}`,
    known: false,
  };
}

export function rejectReasonText(code: string | null | undefined): string {
  return rejectReason(code).text;
}
