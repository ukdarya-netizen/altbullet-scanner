const DUBAI_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Dubai",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const TIMING_PREFIX = "🕒 <b>Обнаружен:</b>";
const DELAY_THRESHOLD_MS = 5 * 60_000;

export function formatPrimarySignalTiming(
  detectedAt: Date,
  deliveryAt: Date,
): string {
  const detected = DUBAI_TIME.format(detectedAt).replace(",", "");
  const elapsedMs = deliveryAt.getTime() - detectedAt.getTime();
  const delay =
    elapsedMs >= DELAY_THRESHOLD_MS
      ? ` · ⚠️ <b>Доставка с задержкой ${Math.floor(elapsedMs / 60_000)} мин</b>`
      : "";
  return `${TIMING_PREFIX} ${detected} (Dubai)${delay}`;
}

/** Replace a queued timestamp at dispatch, including captions queued before this feature. */
export function withPrimarySignalTiming(
  text: string,
  detectedAt: Date,
  deliveryAt: Date,
  maxLength?: number,
): string {
  const line = formatPrimarySignalTiming(detectedAt, deliveryAt);
  const lines = text
    .split("\n")
    .filter((part) => !part.startsWith(TIMING_PREFIX));
  const symbolIndex = lines.findIndex((part) => part.startsWith("🪙 <b>"));
  lines.splice(symbolIndex >= 0 ? symbolIndex + 1 : 1, 0, line);
  if (maxLength != null) {
    // Preserve entry, protection, management, and market links in old queued captions.
    for (const prefix of ["📊 ", "⚠️ ", "📈 ", "🎯 <b>"]) {
      while (lines.join("\n").length > maxLength) {
        const index = lines.findIndex((part) => part.startsWith(prefix));
        if (index < 0) break;
        lines.splice(index, 1);
      }
    }
    if (lines.join("\n").length > maxLength) {
      throw new Error(
        "Primary signal caption cannot fit timing and mandatory trading details",
      );
    }
  }
  return lines.join("\n");
}
