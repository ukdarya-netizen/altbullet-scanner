import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  escapeTelegramHtmlText,
  isTelegramHtmlParseError,
  prepareTelegramHtmlForEnqueue,
  telegramHtml,
  telegramReportPlainText,
  telegramHtmlToPlainText,
  telegramHtmlToPlainTextWithLinkEntities,
  validateTelegramHtml,
} from "../src/lib/telegram-html.js";
import {
  classifyTelegramAttempt,
  getTelegramRetryDelayMs,
  shouldRetryTelegramAttempt,
} from "../src/lib/telegram-photo-outbox-policy.js";
import {
  appendTradingViewLinks,
  formatMarketLinks,
} from "../src/lib/telegram-chart-link.js";

describe("Telegram delivery safety policy", () => {
  test("escapes every dynamic HTML interpolation centrally", () => {
    const text = telegramHtml`<b>${"MNT < BOME & BTC"}</b>`;
    assert.equal(text, "<b>MNT &lt; BOME &amp; BTC</b>");
    assert.deepEqual(validateTelegramHtml(text), { valid: true });
    assert.equal(escapeTelegramHtmlText("<script>&"), "&lt;script&gt;&amp;");
  });

  test("repairs malformed HTML before enqueue and can render it as plain text", () => {
    const prepared = prepareTelegramHtmlForEnqueue(
      "<b>Signal</b> dynamic < broken",
    );
    assert.equal(prepared.repaired, true);
    assert.deepEqual(validateTelegramHtml(prepared.html), { valid: true });
    assert.equal(
      telegramHtmlToPlainText("<b>MNT &amp; BOME</b>"),
      "MNT & BOME",
    );
    assert.equal(
      telegramHtmlToPlainText(
        '📆 <b>ИТОГИ МЕСЯЦА</b>\n<i>Последние 30 дней</i>\n<a href="https://example.com/chart">График</a>',
      ),
      "📆 ИТОГИ МЕСЯЦА\nПоследние 30 дней\nГрафик (https://example.com/chart)",
    );
  });

  test("report plain text removes tags before every delivery and retry path", () => {
    const report = telegramReportPlainText(
      "<b>DAILY REPORT</b>\n&lt;i&gt;escaped&lt;/i&gt;\n&amp;lt;b&amp;gt;double&amp;lt;/b&amp;gt;",
    );
    assert.equal(report, "DAILY REPORT\nescaped\ndouble");
    assert.doesNotMatch(report, /<\/?[a-z][^>]*>/i);

    const processedAgain = telegramHtmlToPlainTextWithLinkEntities(report).text;
    assert.equal(processedAgain, report);
    assert.doesNotMatch(processedAgain, /<\/?[a-z][^>]*>/i);
  });

  test("plain-text fallback never exposes tags after enqueue repair", () => {
    const prepared = prepareTelegramHtmlForEnqueue(
      "🏁 <b>POSITION CLOSED — CORE</b>\nP&L ниже −5%",
    );
    assert.equal(prepared.repaired, true);

    const fallback = telegramReportPlainText(prepared.html);
    assert.equal(fallback, "🏁 POSITION CLOSED — CORE\nP&L ниже −5%");
    assert.doesNotMatch(fallback, /<\/?b>/i);
  });

  test("keeps compact clickable links without exposing their URLs", () => {
    const prepared = telegramHtmlToPlainTextWithLinkEntities(
      '🟣 <b>UAI</b>\n📊 <b>График:</b> <a href="https://example.com/UAI">TradingView — UAI</a>',
    );

    assert.equal(prepared.text, "🟣 UAI\n📊 График: TradingView — UAI");
    assert.deepEqual(prepared.entities, [
      {
        type: "text_link",
        offset: prepared.text.indexOf("TradingView"),
        length: "TradingView — UAI".length,
        url: "https://example.com/UAI",
      },
    ]);
    assert.doesNotMatch(prepared.text, /https:\/\//);
  });

  test("uses one compact Chart · BingX · OI row everywhere", () => {
    const links = formatMarketLinks("WLD-USDT");
    const prepared = telegramHtmlToPlainTextWithLinkEntities(links);
    assert.equal(prepared.text, "🔗 Chart · BingX · OI");
    assert.equal(prepared.entities.length, 3);
    assert.deepEqual(
      prepared.entities.map((entity) =>
        prepared.text.slice(entity.offset, entity.offset + entity.length),
      ),
      ["Chart", "BingX", "OI"],
    );

    const autoLinked = appendTradingViewLinks(
      "Позиция WLD-USDT обновлена\n#WLD",
    );
    assert.match(autoLinked, /Chart<\/a> · .*BingX<\/a> · .*OI<\/a>/);
    assert.doesNotMatch(autoLinked, /График:|TradingView —|OI \(CoinGlass\)/);
    assert.equal(appendTradingViewLinks(autoLinked), autoLinked);
  });

  test("recognizes Telegram entity parse errors", () => {
    assert.equal(
      isTelegramHtmlParseError(
        "Bad Request: can't parse entities: Unsupported start tag",
      ),
      true,
    );
  });

  test("uses retry_after for 429 and bounded jittered backoff otherwise", () => {
    const rateLimited = {
      ok: false,
      status: 429,
      retryable: true,
      retryAfterSeconds: 17,
      description: "Too Many Requests",
    };
    assert.equal(classifyTelegramAttempt(rateLimited), "rate_limited");
    assert.equal(shouldRetryTelegramAttempt(rateLimited), true);
    assert.equal(
      getTelegramRetryDelayMs(rateLimited, 1, () => 0),
      17_000,
    );

    const outage = {
      ok: false,
      status: 503,
      retryable: true,
      description: "temporary outage",
    };
    assert.equal(classifyTelegramAttempt(outage), "server_error");
    assert.equal(
      getTelegramRetryDelayMs(outage, 3, () => 0),
      16_000,
    );
    assert.equal(
      getTelegramRetryDelayMs(outage, 3, () => 1),
      24_000,
    );
    assert.ok(getTelegramRetryDelayMs(outage, 20, () => 1) <= 360_000);
  });
});
