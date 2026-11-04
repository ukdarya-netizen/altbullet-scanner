const TELEGRAM_ALLOWED_TAGS = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ins",
  "s",
  "strike",
  "del",
  "span",
  "tg-spoiler",
  "a",
  "code",
  "pre",
  "blockquote",
]);

const TAG_PATTERN = /<\/?([a-z][a-z0-9-]*)(?:\s+[^<>]*)?>/gi;
const ENTITY_PATTERN = /&(amp|lt|gt|quot|#39|#\d+|#x[0-9a-f]+);/gi;

export function escapeTelegramHtmlText(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function telegramHtml(
  strings: TemplateStringsArray,
  ...dynamicValues: unknown[]
): string {
  return strings.reduce(
    (result, part, index) =>
      result +
      part +
      (index < dynamicValues.length
        ? escapeTelegramHtmlText(dynamicValues[index])
        : ""),
    "",
  );
}

export function validateTelegramHtml(text: string): {
  valid: boolean;
  reason?: string;
} {
  const stack: string[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TAG_PATTERN)) {
    const index = match.index ?? 0;
    const between = text.slice(cursor, index);
    if (between.includes("<") || between.includes(">")) {
      return { valid: false, reason: "unescaped angle bracket" };
    }
    const fullTag = match[0];
    const tag = match[1]!.toLowerCase();
    if (!TELEGRAM_ALLOWED_TAGS.has(tag)) {
      return { valid: false, reason: `unsupported tag ${tag}` };
    }
    const closing = fullTag.startsWith("</");
    if (closing) {
      if (stack.at(-1) !== tag) {
        return { valid: false, reason: `unbalanced closing tag ${tag}` };
      }
      stack.pop();
    } else {
      stack.push(tag);
    }
    cursor = index + fullTag.length;
  }
  const tail = text.slice(cursor);
  if (tail.includes("<") || tail.includes(">")) {
    return { valid: false, reason: "unescaped angle bracket" };
  }
  const textWithoutEntities = text.replace(ENTITY_PATTERN, "");
  if (textWithoutEntities.includes("&")) {
    return { valid: false, reason: "unescaped ampersand" };
  }
  if (stack.length > 0) {
    return { valid: false, reason: `unclosed tag ${stack.at(-1)}` };
  }
  return { valid: true };
}

export function prepareTelegramHtmlForEnqueue(text: string): {
  html: string;
  repaired: boolean;
  reason?: string;
} {
  const validation = validateTelegramHtml(text);
  if (validation.valid) return { html: text, repaired: false };
  return {
    html: escapeTelegramHtmlText(text),
    repaired: true,
    reason: validation.reason,
  };
}

export function telegramHtmlToPlainText(text: string): string {
  return text
    .replace(
      /<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis,
      (_match, href: string, label: string) =>
        label ? `${label} (${href})` : href,
    )
    .replace(TAG_PATTERN, "")
    .replace(ENTITY_PATTERN, (entity, name: string) => {
      const normalized = name.toLowerCase();
      if (normalized === "amp") return "&";
      if (normalized === "lt") return "<";
      if (normalized === "gt") return ">";
      if (normalized === "quot") return '"';
      if (normalized === "#39") return "'";
      if (normalized.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
      }
      if (normalized.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
      }
      return entity;
    });
}

/**
 * Plain-text boundary for user-facing reports. Unlike the generic converter,
 * this also removes tag-like text that appears only after entity decoding, so
 * caption splitting, outbox persistence, and later retries cannot expose it.
 */
export function telegramReportPlainText(text: string): string {
  let plain = telegramHtmlToPlainText(text);
  for (let pass = 0; pass < 3; pass += 1) {
    const sanitized = telegramHtmlToPlainText(plain).replace(
      /<\/?[a-z][^>]*>/gi,
      "",
    );
    if (sanitized === plain) return sanitized;
    plain = sanitized;
  }
  return plain;
}

export type TelegramTextLinkEntity = {
  type: "text_link";
  offset: number;
  length: number;
  url: string;
};

/**
 * Converts legacy Telegram HTML to plain text while preserving anchor tags as
 * Bot API text_link entities. Telegram entity offsets use UTF-16 code units,
 * which matches JavaScript string length semantics.
 */
export function telegramHtmlToPlainTextWithLinkEntities(text: string): {
  text: string;
  entities: TelegramTextLinkEntity[];
} {
  const anchorPattern = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
  const entities: TelegramTextLinkEntity[] = [];
  let plainText = "";
  let cursor = 0;

  for (const match of text.matchAll(anchorPattern)) {
    const index = match.index ?? 0;
    plainText += telegramHtmlToPlainText(text.slice(cursor, index));

    const url = telegramHtmlToPlainText(match[1] ?? "").trim();
    const label = telegramHtmlToPlainText(match[2] ?? "").trim();
    if (label && url) {
      const offset = plainText.length;
      plainText += label;
      entities.push({
        type: "text_link",
        offset,
        length: label.length,
        url,
      });
    } else {
      plainText += label || url;
    }
    cursor = index + match[0].length;
  }

  plainText += telegramHtmlToPlainText(text.slice(cursor));
  return { text: plainText, entities };
}

export function isTelegramHtmlParseError(
  description: string | undefined,
): boolean {
  return /can't parse entities|unsupported start tag|can't find end tag|wrong nested/i.test(
    description ?? "",
  );
}
