/**
 * Observational volume context captured at signal fire time for every pattern.
 *
 * Reports the last closed candles' volume against the prior 20 closed candles
 * (1H and 30m). Never changes an entry decision; stored in
 * tracked_signals.decision_metrics.entryVolume for later outcome comparison.
 */
export const ENTRY_VOLUME_CONTEXT_VERSION = "entry_volume_ctx:v1" as const;

const LOOKBACK = 20;
const LAST_BARS = 3;

export interface VolumeCandle {
  time: number;
  close: number;
  volume: number;
}

export interface VolumeBarContext {
  time: number;
  volume: number;
  turnoverUsd: number;
  priorMeanVolume: number;
  ratio: number;
}

export interface VolumeTimeframeContext {
  available: boolean;
  reason?: "no_candles" | "insufficient_history" | "invalid_volume";
  /** Most recent closed bar first. */
  bars: VolumeBarContext[];
}

export interface EntryVolumeContext {
  version: typeof ENTRY_VOLUME_CONTEXT_VERSION;
  capturedAt: number;
  tf1h: VolumeTimeframeContext;
  tf30m: VolumeTimeframeContext;
}

function buildTimeframe(
  rows: readonly VolumeCandle[] | null,
  barMs: number,
  now: number,
): VolumeTimeframeContext {
  if (!rows || rows.length === 0)
    return { available: false, reason: "no_candles", bars: [] };
  const closed = rows
    .filter((c) => Number.isFinite(c.time) && c.time + barMs <= now)
    .sort((a, b) => a.time - b.time);
  const bars: VolumeBarContext[] = [];
  for (let n = 0; n < LAST_BARS; n += 1) {
    const index = closed.length - 1 - n;
    const prior = closed.slice(Math.max(0, index - LOOKBACK), index);
    if (index < 0 || prior.length !== LOOKBACK) break;
    const bar = closed[index]!;
    const valid =
      Number.isFinite(bar.volume) &&
      bar.volume > 0 &&
      Number.isFinite(bar.close) &&
      prior.every((c) => Number.isFinite(c.volume) && c.volume > 0);
    if (!valid) return { available: false, reason: "invalid_volume", bars: [] };
    const priorMeanVolume = prior.reduce((s, c) => s + c.volume, 0) / LOOKBACK;
    bars.push({
      time: bar.time,
      volume: bar.volume,
      turnoverUsd: bar.volume * bar.close,
      priorMeanVolume,
      ratio: bar.volume / priorMeanVolume,
    });
  }
  return bars.length === 0
    ? { available: false, reason: "insufficient_history", bars: [] }
    : { available: true, bars };
}

export function buildEntryVolumeContext(input: {
  candles1h: readonly VolumeCandle[] | null;
  candles30m: readonly VolumeCandle[] | null;
  now: number;
}): EntryVolumeContext {
  return {
    version: ENTRY_VOLUME_CONTEXT_VERSION,
    capturedAt: input.now,
    tf1h: buildTimeframe(input.candles1h, 60 * 60 * 1000, input.now),
    tf30m: buildTimeframe(input.candles30m, 30 * 60 * 1000, input.now),
  };
}
