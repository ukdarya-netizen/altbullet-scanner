import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  TELEGRAM_BOT_MENU,
  TELEGRAM_CALLBACKS,
  TELEGRAM_COMMANDS,
  canReclaimTelegramUpdate,
  checkTelegramCommandAccess,
  findTelegramCommand,
  getTelegramUpdateId,
  isTelegramCallback,
  isPublicSetupCommand,
  parseTelegramCommand,
  SUBSCRIBER_MENU_KEYBOARD,
} from "../src/lib/telegram-inbound.js";
import {
  callTelegramApi,
  getTelegramWebhookSecret,
  registerBotCommands,
  setWebhook,
  shouldRetryCallbackAcknowledgement,
  verifyTelegramWebhookSecret,
} from "../src/lib/telegram-api.js";
import {
  getTelegramPhotoDeliveryKey,
  shouldFallbackToTextAfterPhotoFailure,
  shouldRetryExplicitPhotoFailure,
} from "../src/lib/photo-delivery-policy.js";
import {
  buildTelegramPhotoDeliveryContent,
  buildTelegramPhotoDeliveryRows,
  buildTelegramTextDeliveryRows,
  getPendingTelegramTextParts,
  getTelegramPhotoResultTransition,
  getTelegramTextResultStatus,
  resolveTelegramRecipientSource,
  runTelegramPhotoAfterRecipientResolution,
  runTelegramPhotoClaimTransaction,
} from "../src/lib/telegram-photo-outbox-policy.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Telegram photo delivery safety", () => {
  test("uses business event identity rather than equal notification copy", () => {
    assert.equal(
      getTelegramPhotoDeliveryKey("cancel:42:smart_cancel"),
      "cancel:42:smart_cancel",
    );
    assert.notEqual(
      getTelegramPhotoDeliveryKey("cancel:42:smart_cancel"),
      getTelegramPhotoDeliveryKey("cancel:43:smart_cancel"),
    );
  });

  test("creates one independently claimable row for channel and every user", () => {
    const rows = buildTelegramPhotoDeliveryRows(
      {
        photoPath: "/assets/position.png",
        text: "POSITION UPDATE",
        targets: ["@altbullet", 101, 202],
      },
      "position:55:state:follow->hold:2026-08-19T10:00:00.000Z",
      new Date("2026-08-19T10:00:00.000Z"),
    );

    assert.deepEqual(
      rows.map((row) => row.target),
      ["@altbullet", "101", "202"],
    );
    assert.equal(
      new Set(rows.map((row) => `${row.dedupKey}:${row.target}`)).size,
      3,
    );
    assert.ok(rows.every((row) => row.status === "ready"));
  });

  test("uses the same recipient-level queue for text-only critical events", () => {
    const rows = buildTelegramTextDeliveryRows(
      {
        text: "MILESTONE +10%",
        targets: ["@altbullet", 101],
      },
      "milestone:v3:1273:first_target:10",
      new Date("2026-08-25T10:00:00.000Z"),
    );

    assert.deepEqual(
      rows.map((row) => ({
        target: row.target,
        phase: row.phase,
        photoPath: row.photoPath,
        deliveryPolicyVersion: row.deliveryPolicyVersion,
      })),
      [
        {
          target: "@altbullet",
          phase: "fallback",
          photoPath: "",
          deliveryPolicyVersion: 4,
        },
        {
          target: "101",
          phase: "fallback",
          photoPath: "",
          deliveryPolicyVersion: 4,
        },
      ],
    );
  });

  test("deduplicates one event but not identical copy from another event", () => {
    const params = {
      photoPath: "/assets/cancel.png",
      text: "SIGNAL CANCELLED — same rendered copy",
      targets: [101],
    };
    const first = buildTelegramPhotoDeliveryRows(params, "cancel:55:stale")[0]!;
    const replay = buildTelegramPhotoDeliveryRows(
      params,
      "cancel:55:stale",
    )[0]!;
    const unrelated = buildTelegramPhotoDeliveryRows(
      params,
      "cancel:56:stale",
    )[0]!;

    assert.equal(
      `${first.dedupKey}:${first.target}`,
      `${replay.dedupKey}:${replay.target}`,
    );
    assert.notEqual(
      `${first.dedupKey}:${first.target}`,
      `${unrelated.dedupKey}:${unrelated.target}`,
    );
  });

  test("uses the same recipient key when a pending primary signal is recovered", () => {
    const params = {
      photoPath: "/assets/signal.png",
      text: "PRIMARY SIGNAL",
      targets: [101],
    };
    const initial = buildTelegramPhotoDeliveryRows(params, "signal:712")[0]!;
    const recovery = buildTelegramPhotoDeliveryRows(params, "signal:712")[0]!;

    assert.equal(
      `${initial.dedupKey}:${initial.target}`,
      `${recovery.dedupKey}:${recovery.target}`,
    );
  });

  test("uses text fallback only after an explicit permanent photo rejection", () => {
    assert.deepEqual(
      getTelegramPhotoResultTransition(
        {
          ok: false,
          status: 400,
          retryable: false,
          description: "Bad Request: wrong file identifier",
        },
        true,
      ),
      { status: "processing", phase: "fallback" },
    );
  });

  test("quarantines an ambiguous photo timeout or server error instead of retrying it", () => {
    assert.deepEqual(
      getTelegramPhotoResultTransition(
        {
          ok: false,
          status: null,
          retryable: true,
          description: "request timed out",
        },
        true,
      ),
      { status: "ambiguous", phase: "photo" },
    );
    assert.deepEqual(
      getTelegramPhotoResultTransition(
        {
          ok: false,
          status: 503,
          retryable: true,
          description: "temporary outage",
        },
        false,
      ),
      { status: "ambiguous", phase: "photo" },
    );
    assert.deepEqual(
      getTelegramPhotoResultTransition(
        {
          ok: false,
          status: 403,
          retryable: false,
          description: "Forbidden",
        },
        false,
      ),
      { status: "processing", phase: "fallback" },
    );
  });

  test("retries a photo only when Telegram explicitly rejected it with 429", () => {
    assert.deepEqual(
      getTelegramPhotoResultTransition(
        {
          ok: false,
          status: 429,
          retryable: true,
          description: "Too Many Requests",
        },
        false,
      ),
      { status: "retry", phase: "photo" },
    );
  });

  test("quarantines an ambiguous text timeout but retries explicit rejection", () => {
    assert.equal(
      getTelegramTextResultStatus({
        ok: false,
        status: null,
        retryable: true,
        description: "request timed out",
      }),
      "ambiguous",
    );
    assert.equal(
      getTelegramTextResultStatus({
        ok: false,
        status: 429,
        retryable: true,
        description: "Too Many Requests",
      }),
      "retry",
    );
    assert.equal(
      getTelegramTextResultStatus({
        ok: false,
        status: 503,
        retryable: true,
        description: "temporary outage",
      }),
      "ambiguous",
    );
  });

  test("persists long continuations and resumes at the next unsent chunk", () => {
    const text = [
      "POSITION UPDATE",
      "a".repeat(950),
      "b".repeat(3_800),
      "c".repeat(3_800),
    ].join("\n");
    const content = buildTelegramPhotoDeliveryContent(text);

    assert.ok(content.caption.length <= 1_000);
    assert.ok(content.continuationTexts.length >= 2);
    assert.ok(
      content.continuationTexts.every((chunk) => chunk.length <= 4_000),
    );
    assert.deepEqual(
      getPendingTelegramTextParts(content, "continuation", 1),
      content.continuationTexts.slice(1),
    );
    assert.deepEqual(
      getTelegramPhotoResultTransition(
        { ok: true, status: 200, retryable: false },
        true,
      ),
      { status: "processing", phase: "continuation" },
    );
  });

  test("commits a state claim even when there are no recipients", async () => {
    let stateClaimed = false;
    let insertCalled = false;
    const result = await runTelegramPhotoClaimTransaction({
      transaction: { name: "fake-transaction" },
      rows: [],
      claim: async () => {
        stateClaimed = true;
        return true;
      },
      insert: async () => {
        insertCalled = true;
        return 0;
      },
    });

    assert.deepEqual(result, { claimed: true, queued: 0 });
    assert.equal(stateClaimed, true);
    assert.equal(insertCalled, false);
  });

  test("propagates enqueue failure so the database transaction can roll back", async () => {
    await assert.rejects(
      runTelegramPhotoClaimTransaction({
        transaction: { name: "fake-transaction" },
        rows: [{ target: "101" }],
        claim: async () => true,
        insert: async () => {
          throw new Error("simulated outbox insert failure");
        },
      }),
      /simulated outbox insert failure/,
    );
  });

  test("never claims state from a partial recipient snapshot", async () => {
    let claimPathCalled = false;
    await assert.rejects(
      runTelegramPhotoAfterRecipientResolution({
        resolveTargets: async () => {
          throw new Error("simulated subscriber lookup timeout");
        },
        enqueueAfterClaim: async () => {
          claimPathCalled = true;
          return { claimed: true, queued: 1 };
        },
      }),
      /simulated subscriber lookup timeout/,
    );
    assert.equal(claimPathCalled, false);
  });

  test("recipient lookup failure can atomically claim a recoverable event once", async () => {
    let economicClaims = 0;
    let recoveryWrites = 0;
    const persistedEvents = new Set<string>();
    const attempt = () =>
      runTelegramPhotoAfterRecipientResolution({
        resolveTargets: async () => {
          throw new Error("simulated subscriber lookup timeout");
        },
        enqueueAfterClaim: async () => {
          throw new Error("must not use resolved enqueue");
        },
        enqueueAfterResolutionFailure: async () => {
          const claimed = economicClaims === 0;
          if (claimed) economicClaims++;
          // Models ON CONFLICT DO NOTHING on the stable business event key.
          persistedEvents.add("position:464:profit:trailing_stop");
          recoveryWrites = persistedEvents.size;
          return { claimed, queued: 0 };
        },
      });

    assert.deepEqual(await attempt(), { claimed: true, queued: 0 });
    assert.deepEqual(await attempt(), { claimed: false, queued: 0 });
    assert.equal(economicClaims, 1);
    assert.equal(recoveryWrites, 1);
  });

  test("strict primary recipient resolution rejects an unavailable subscriber source", async () => {
    await assert.rejects(
      resolveTelegramRecipientSource({
        source: "Active Telegram subscriber",
        strict: true,
        load: async () => {
          throw new Error("simulated database timeout");
        },
        fallback: () => [] as number[],
      }),
      /Active Telegram subscriber lookup failed/,
    );
  });

  test("never turns an ambiguous photo timeout into a duplicate text message", () => {
    assert.equal(
      shouldFallbackToTextAfterPhotoFailure({
        ok: false,
        status: null,
        retryable: true,
        description: "request timed out",
      }),
      false,
    );
    assert.equal(
      shouldRetryExplicitPhotoFailure({
        ok: false,
        status: null,
        retryable: true,
      }),
      false,
    );
  });

  test("retries explicit temporary rejections and falls back only on confirmed failures", () => {
    assert.equal(
      shouldRetryExplicitPhotoFailure({
        ok: false,
        status: 429,
        retryable: true,
      }),
      true,
    );
    assert.equal(
      shouldRetryExplicitPhotoFailure({
        ok: false,
        status: 503,
        retryable: true,
      }),
      false,
    );
    assert.equal(
      shouldFallbackToTextAfterPhotoFailure({
        ok: false,
        status: 400,
        retryable: false,
      }),
      true,
    );
  });
});

describe("Telegram command parsing and registry", () => {
  test("covers every supported canonical command and alias exactly", () => {
    const expectedCanonical = [
      "/start",
      "/myid",
      "/menu",
      "/whalewatch",
      "/daily",
      "/weekly",
      "/monthly",
      "/prices",
      "/subscription",
      "/unsubscribe",
      "/resetpassword",
      "/activate_test",
      "/addsub",
      "/removesub",
      "/listsubs",
      "/addsignal",
    ];
    assert.deepEqual(
      TELEGRAM_COMMANDS.map((definition) => definition.command),
      expectedCanonical,
    );

    for (const definition of TELEGRAM_COMMANDS) {
      const names = [definition.command, ...(definition.aliases ?? [])];
      for (const name of names) {
        assert.equal(findTelegramCommand(name), definition, name);
        assert.deepEqual(
          parseTelegramCommand(`${name}@AltBulletBot one two`),
          { command: name, args: ["one", "two"] },
          `${name} with bot suffix`,
        );
      }
    }

    assert.equal(findTelegramCommand("/start_extra"), undefined);
    assert.equal(parseTelegramCommand("hello"), null);
    assert.equal(parseTelegramCommand(""), null);
    assert.equal(parseTelegramCommand(undefined), null);
    assert.equal(isPublicSetupCommand("/myid@AltBulletBot"), true);
    assert.equal(isPublicSetupCommand("/start"), true);
    assert.equal(isPublicSetupCommand("/prices"), true);
    assert.equal(isPublicSetupCommand("/resetpassword"), false);
    assert.equal(isPublicSetupCommand("/subscription"), false);
    assert.equal(isPublicSetupCommand("/daily"), false);
    assert.equal(getTelegramUpdateId({ update_id: 123 }), 123);
    assert.equal(getTelegramUpdateId({ update_id: "123" }), null);
    assert.equal(getTelegramUpdateId({}), null);
    assert.equal(getTelegramUpdateId(null), null);
  });

  test("publishes every supported user command and no owner-only command", () => {
    assert.deepEqual(
      TELEGRAM_BOT_MENU.map((item) => item.command),
      [
        "start",
        "myid",
        "daily",
        "weekly",
        "monthly",
        "prices",
        "subscription",
        "unsubscribe",
        "resetpassword",
      ],
    );
    assert.equal(
      TELEGRAM_BOT_MENU.some((item) => item.command === "addsignal"),
      false,
    );
  });
});

describe("Telegram access matrix", () => {
  for (const definition of TELEGRAM_COMMANDS) {
    test(`${definition.command}: public/subscriber/owner/group states`, () => {
      const publicDecision = checkTelegramCommandAccess(definition, {
        isOwner: false,
        isSubscriber: false,
        chatType: "private",
      });
      const subscriberDecision = checkTelegramCommandAccess(definition, {
        isOwner: false,
        isSubscriber: true,
        chatType: "private",
      });
      const ownerDecision = checkTelegramCommandAccess(definition, {
        isOwner: true,
        isSubscriber: false,
        chatType: "private",
      });

      if (definition.access === "public") {
        assert.deepEqual(publicDecision, { allowed: true });
      } else if (definition.access === "subscriber") {
        assert.deepEqual(publicDecision, {
          allowed: false,
          reason: "subscription",
        });
        assert.deepEqual(subscriberDecision, { allowed: true });
        assert.deepEqual(ownerDecision, { allowed: true });
      } else {
        assert.deepEqual(publicDecision, {
          allowed: false,
          reason: "owner",
        });
        assert.deepEqual(subscriberDecision, {
          allowed: false,
          reason: "owner",
        });
        assert.deepEqual(ownerDecision, { allowed: true });
      }

      const groupDecision = checkTelegramCommandAccess(definition, {
        isOwner: true,
        isSubscriber: true,
        chatType: "group",
      });
      assert.deepEqual(
        groupDecision,
        definition.privateOnly
          ? { allowed: false, reason: "private_chat" }
          : { allowed: true },
      );
    });
  }
});

describe("Telegram callback matrix", () => {
  test("recognizes all callbacks and rejects malformed data", () => {
    assert.deepEqual(TELEGRAM_CALLBACKS, [
      "subscription_status",
      "unsubscribe_confirm",
      "unsubscribe_yes",
      "unsubscribe_no",
    ]);
    for (const callback of TELEGRAM_CALLBACKS) {
      assert.equal(isTelegramCallback(callback), true);
    }
    assert.equal(isTelegramCallback("unsubscribe"), false);
    assert.equal(isTelegramCallback(""), false);
  });

  test("subscriber menu has no open-positions button", () => {
    assert.equal(
      JSON.stringify(SUBSCRIBER_MENU_KEYBOARD).includes("positions_status"),
      false,
    );
  });

  test("callbacks inherit the private subscriber/owner unsubscribe rule", () => {
    const definition = findTelegramCommand("/unsubscribe");
    assert.ok(definition);
    assert.deepEqual(
      checkTelegramCommandAccess(definition, {
        isOwner: false,
        isSubscriber: true,
        chatType: "private",
      }),
      { allowed: true },
    );
    assert.deepEqual(
      checkTelegramCommandAccess(definition, {
        isOwner: false,
        isSubscriber: false,
        chatType: "private",
      }),
      { allowed: false, reason: "subscription" },
    );
    assert.deepEqual(
      checkTelegramCommandAccess(definition, {
        isOwner: true,
        isSubscriber: true,
        chatType: "supergroup",
      }),
      { allowed: false, reason: "private_chat" },
    );
  });
});

describe("Telegram update retry decisions", () => {
  const now = new Date("2026-08-19T10:00:00Z");

  test("reclaims failed and expired processing updates only", () => {
    assert.equal(canReclaimTelegramUpdate("failed", now, now), true);
    assert.equal(
      canReclaimTelegramUpdate(
        "processing",
        new Date("2026-08-19T09:54:59Z"),
        now,
      ),
      true,
    );
    assert.equal(
      canReclaimTelegramUpdate(
        "processing",
        new Date("2026-08-19T09:59:00Z"),
        now,
      ),
      false,
    );
    assert.equal(canReclaimTelegramUpdate("completed", now, now), false);
    assert.equal(
      canReclaimTelegramUpdate("completion_pending", now, now),
      false,
    );
    assert.equal(canReclaimTelegramUpdate(undefined, undefined, now), false);
  });
});

describe("Telegram API failures and webhook registration", () => {
  test("validates webhook requests with a constant-time derived secret", () => {
    const expected = getTelegramWebhookSecret();
    assert.ok(expected);
    assert.equal(verifyTelegramWebhookSecret(expected), true);
    assert.equal(verifyTelegramWebhookSecret("forged"), false);
    assert.equal(verifyTelegramWebhookSecret(undefined), false);
  });

  test("classifies temporary and permanent sender failures", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ ok: false, description: "temporary outage" }),
        { status: 503 },
      );
    const temporary = await callTelegramApi("sendMessage", {
      body: { chat_id: 123, text: "test" },
    });
    assert.equal(temporary.ok, false);
    assert.equal(temporary.retryable, true);
    assert.equal(temporary.status, 503);
    assert.equal(shouldRetryCallbackAcknowledgement(temporary), true);

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: false, description: "blocked" }), {
        status: 400,
      });
    const permanent = await callTelegramApi("sendMessage", {
      body: { chat_id: "not-a-number", text: "test" },
    });
    assert.equal(permanent.ok, false);
    assert.equal(permanent.retryable, false);
    assert.equal(permanent.status, 400);
    assert.equal(shouldRetryCallbackAcknowledgement(permanent), false);
  });

  test("requires Telegram's explicit API acceptance even for a 2xx response", async () => {
    for (const body of ["", "not-json", JSON.stringify({ ok: false })]) {
      globalThis.fetch = async () => new Response(body, { status: 200 });
      const result = await callTelegramApi("sendMessage", {
        body: { chat_id: 123, text: "test" },
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 200);
    }
    assert.equal(
      getTelegramTextResultStatus({
        ok: false,
        status: 200,
        retryable: false,
        description:
          "Telegram API response did not explicitly accept the request",
      }),
      "ambiguous",
    );
  });

  test("registers messages and callbacks without dropping queued updates", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/getWebhookInfo")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              url: "https://example.test/api/telegram/webhook",
              allowed_updates: ["message", "callback_query"],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };

    assert.equal(
      await setWebhook("https://example.test/api/telegram/webhook"),
      true,
    );
    const payload = JSON.parse(String(calls[0].init?.body)) as {
      allowed_updates: string[];
      drop_pending_updates: boolean;
      secret_token: string;
    };
    assert.deepEqual(payload.allowed_updates, ["message", "callback_query"]);
    assert.equal(payload.drop_pending_updates, false);
    assert.equal(payload.secret_token, getTelegramWebhookSecret());
    assert.equal(calls[1].url.endsWith("/getWebhookInfo"), true);
  });

  test("fails startup verification when callbacks were not accepted", async () => {
    let call = 0;
    globalThis.fetch = async () => {
      call++;
      return call === 1
        ? new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          })
        : new Response(
            JSON.stringify({
              ok: true,
              result: {
                url: "https://example.test/api/telegram/webhook",
                allowed_updates: ["message"],
              },
            }),
            { status: 200 },
          );
    };
    assert.equal(
      await setWebhook("https://example.test/api/telegram/webhook"),
      false,
    );
  });

  test("registers the command menu from the same dispatcher registry", async () => {
    let body = "";
    globalThis.fetch = async (_input, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    assert.equal(await registerBotCommands(), true);
    assert.deepEqual(
      (JSON.parse(body) as { commands: typeof TELEGRAM_BOT_MENU }).commands,
      TELEGRAM_BOT_MENU,
    );
  });
});
