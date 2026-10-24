const EMAIL_PATTERN = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
const URL_PATTERN = /https?:\/\/\S+/gi;
const BEARER_PATTERN = /bearer\s+\S+/gi;
const SECRET_FIELD_PATTERN =
  /\b(?:token|password|authorization|secret|code)\s*[:=]\s*\S+/gi;
const LONG_VALUE_PATTERN = /\b[a-z0-9_-]{32,}\b/gi;
const LONG_NUMBER_PATTERN = /\b\d{5,}\b/g;

export function sanitizeClientErrorText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (!value?.trim()) return undefined;
  return value
    .replace(URL_PATTERN, "[url]")
    .replace(EMAIL_PATTERN, "[email]")
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(SECRET_FIELD_PATTERN, "[redacted]")
    .replace(LONG_VALUE_PATTERN, "[redacted]")
    .replace(LONG_NUMBER_PATTERN, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function sanitizeClientErrorRoute(value: string): string {
  const pathname = value.split(/[?#]/, 1)[0] || "/";
  return (
    sanitizeClientErrorText(pathname, 160)
      ?.replace(/[^a-z0-9/_.~%:[\]-]/gi, "_")
      .slice(0, 160) || "/"
  );
}
