/** Elapsed time shown alongside position timestamps; hours reset after each 24h day. */
export function formatPositionAge(
  date: string | Date,
  now = Date.now(),
): string {
  const start = new Date(date).getTime();
  if (!Number.isFinite(start)) return "—";

  const totalMinutes = Math.max(0, Math.floor((now - start) / 60_000));
  if (totalMinutes < 60) return `${totalMinutes} мин`;

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours} ч`;

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days} д ${hours} ч`;
}

/** How long a signal was (or has been) active: issue time to close time, or to now while open. */
export function formatActiveDuration(
  detectedAt: string | Date,
  closedAt?: string | Date | null,
): string {
  const end = closedAt ? new Date(closedAt).getTime() : Date.now();
  return formatPositionAge(detectedAt, Number.isFinite(end) ? end : Date.now());
}

/**
 * End of a signal's life: close time, or for neutral closes (no closed_at by
 * design) the time the row was last updated. Open signals have no end.
 */
export function signalEndTime(s: {
  status?: string | null;
  closedAt?: string | Date | null;
  updatedAt?: string | Date | null;
}): string | Date | null {
  if (s.closedAt) return s.closedAt;
  if (s.status && s.status !== "active" && s.status !== "in_run") {
    return s.updatedAt ?? null;
  }
  return null;
}
