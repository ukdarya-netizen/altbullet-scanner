import {
  reportClientError,
  type ClientErrorReport,
} from "@workspace/api-client-react";

type ErrorKind = ClientErrorReport["kind"];

const sent = new Map<string, number>();
const DEDUP_WINDOW_MS = 5 * 60_000;
const MAX_REPORTS_PER_MINUTE = 5;
let rateWindowStartedAt = Date.now();
let reportsInWindow = 0;

function browserFamily(): ClientErrorReport["browserFamily"] {
  const ua = navigator.userAgent;
  if (/SamsungBrowser/i.test(ua)) return "Samsung Internet";
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\//i.test(ua)) return "Opera";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua)) return "Safari";
  return "Other";
}

function sanitize(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:token|password|authorization)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\b\d{5,}\b/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function route(): string {
  return window.location.pathname.slice(0, 160);
}

export function captureClientError(input: {
  kind: ErrorKind;
  error: unknown;
  component?: string;
  httpStatus?: number;
}): void {
  try {
    if (!localStorage.getItem("authToken")) return;
  } catch {
    return;
  }

  const rawMessage =
    input.error instanceof Error
      ? `${input.error.name}: ${input.error.message}`
      : String(input.error);
  const message = sanitize(rawMessage, 240);
  const component = sanitize(input.component, 120);
  const currentRoute = route();
  const fingerprint = hash(
    `${input.kind}|${currentRoute}|${message ?? "unknown"}|${component ?? ""}|${input.httpStatus ?? ""}`,
  );
  const now = Date.now();

  if (now - rateWindowStartedAt >= 60_000) {
    rateWindowStartedAt = now;
    reportsInWindow = 0;
  }
  if (
    reportsInWindow >= MAX_REPORTS_PER_MINUTE ||
    now - (sent.get(fingerprint) ?? 0) < DEDUP_WINDOW_MS
  ) {
    return;
  }
  sent.set(fingerprint, now);
  reportsInWindow += 1;

  void reportClientError({
    kind: input.kind,
    route: currentRoute || "/",
    appVersion: __APP_VERSION__,
    browserFamily: browserFamily(),
    fingerprint,
    occurredAt: new Date(now).toISOString(),
    ...(message ? { message } : {}),
    ...(component ? { component } : {}),
    ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
  }).catch(() => {
    // Telemetry must never create another user-visible failure.
  });
}

export function installGlobalErrorTelemetry(): void {
  window.addEventListener("error", (event) => {
    captureClientError({
      kind: "window_error",
      error: event.error ?? event.message,
      component: event.filename?.split("/").pop(),
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    captureClientError({
      kind: "unhandled_rejection",
      error: event.reason,
    });
  });
}
