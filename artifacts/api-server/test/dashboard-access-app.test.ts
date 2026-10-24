import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";

const TEST_SESSION_SECRET = "dashboard-access-app-test-secret";
const TEST_ADMIN_PIN = "dashboard-access-app-test-pin";
const integrationDatabaseUrl = process.env.TEST_DATABASE_URL;

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = TEST_SESSION_SECRET;
process.env.ADMIN_DASHBOARD_PIN = TEST_ADMIN_PIN;
process.env.ADMIN_TOKEN = "";
process.env.OWNER_EMAIL = "";

type RunningServer = {
  server: Server;
  url: string;
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function databaseUrlWithSearchPath(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  const existingOptions = url.searchParams.get("options");
  url.searchParams.set(
    "options",
    [existingOptions, `-c search_path=${quoteIdentifier(schema)},public`]
      .filter(Boolean)
      .join(" "),
  );
  return url.toString();
}

async function startTestServer(app: Express) {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  } satisfies RunningServer;
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function get(
  baseUrl: string,
  path: string,
  authorization?: string,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: authorization ? { Authorization: authorization } : undefined,
  });
}

test("real dashboard app keeps API and static access boundaries closed", async () => {
  assert.ok(
    integrationDatabaseUrl,
    "TEST_DATABASE_URL is required for the dashboard app access test",
  );
  const schema = `dashboard_access_test_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = databaseUrlWithSearchPath(
    integrationDatabaseUrl,
    schema,
  );

  const [{ default: app }, { db, dashboardUsersTable, pool }] =
    await Promise.all([import("../src/app.js"), import("@workspace/db")]);

  const quotedSchema = quoteIdentifier(schema);
  let schemaCreated = false;
  let running: RunningServer | undefined;
  try {
    await pool.query(`CREATE SCHEMA ${quotedSchema}`);
    schemaCreated = true;
    await pool.query(`
      CREATE TABLE dashboard_users (
        id serial PRIMARY KEY,
        email text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        name text NOT NULL,
        chat_id text,
        telegram_username text,
        subscribed_until timestamp,
        status text NOT NULL DEFAULT 'pending',
        created_at timestamp NOT NULL DEFAULT now(),
        approved_at timestamp,
        last_login_at timestamp,
        last_activity_at timestamp
      )
    `);

    const email = `dashboard-access-${randomUUID()}@example.test`;
    const [user] = await db
      .insert(dashboardUsersTable)
      .values({
        email,
        passwordHash: "unused-in-access-boundary-test",
        name: "Dashboard access boundary test",
        status: "approved",
        subscribedUntil: new Date(Date.now() - 60_000),
      })
      .returning({ id: dashboardUsersTable.id });
    assert.ok(user);

    const expiredToken = jwt.sign(
      { userId: user.id, email, name: "Dashboard access boundary test" },
      TEST_SESSION_SECRET,
    );

    running = await startTestServer(app);
    for (const path of [
      "/api/signals/summary",
      "/api/tracker",
      "/api/settings",
      "/api/scanner/status",
      "/api/scanner/breakout-analysis",
      "/api/scanner/breakout-analysis/!",
      "/api/scanner/breakout-replay",
    ]) {
      const response = await get(running.url, path);
      assert.equal(
        response.status,
        401,
        `anonymous request to ${path} must require dashboard access`,
      );
    }

    for (const [method, path, body] of [
      ["GET", "/api/auth/me", undefined],
      ["POST", "/api/auth/heartbeat", undefined],
      ["GET", "/api/signals/summary", undefined],
      ["GET", "/api/scanner/breakout-analysis", undefined],
      ["GET", "/api/scanner/breakout-analysis/!", undefined],
      ["GET", "/api/scanner/breakout-replay", undefined],
    ] as const) {
      const response = await fetch(`${running.url}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${expiredToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body,
      });
      assert.equal(
        response.status,
        403,
        `expired account must be rejected by ${method} ${path}`,
      );
      const responseBody = (await response.json()) as {
        code?: string;
      };
      assert.equal(responseBody.code, "subscription_expired");
    }

    await db
      .update(dashboardUsersTable)
      .set({ subscribedUntil: new Date(Date.now() + 60_000) })
      .where(eq(dashboardUsersTable.id, user.id));
    const regularUserToken = jwt.sign(
      { userId: 999_999, email: "not-an-admin@example.test", role: "user" },
      TEST_SESSION_SECRET,
    );
    const regularUserResponse = await get(
      running.url,
      "/api/admin/users",
      `Bearer ${regularUserToken}`,
    );
    assert.equal(regularUserResponse.status, 401);

    const invalidPinResponse = await fetch(
      `${running.url}/api/admin/verify-pin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "wrong-pin" }),
      },
    );
    assert.equal(invalidPinResponse.status, 401);

    const pinResponse = await fetch(`${running.url}/api/admin/verify-pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: TEST_ADMIN_PIN }),
    });
    assert.equal(pinResponse.status, 200);
    const pinBody = (await pinResponse.json()) as { token?: string };
    assert.equal(typeof pinBody.token, "string");

    const adminResponse = await get(
      running.url,
      "/api/admin/users",
      `Bearer ${pinBody.token}`,
    );
    assert.equal(adminResponse.status, 200);

    for (const path of [
      "/alpha-scanner-source.zip",
      "/source.zip",
      "/src.tar",
      "/artifacts/alpha-scanner-source.zip",
    ]) {
      const response = await get(running.url, path);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(
        response.status,
        404,
        `source-like path ${path} must not be served by the API app`,
      );
      assert.notDeepEqual(
        Array.from(bytes.slice(0, 2)),
        [0x50, 0x4b],
        `source-like path ${path} must not return ZIP archive bytes`,
      );
    }

    const { readdir } = await import("node:fs/promises");
    const publicFiles = await readdir("../alpha-scanner/public");
    assert.deepEqual(
      publicFiles.filter((file) => /\.(zip|tar|tgz|gz)$/i.test(file)),
      [],
      "frontend public assets must not contain source archives",
    );
  } finally {
    if (running) await stopTestServer(running.server);
    if (schemaCreated) {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    }
    await pool.end();
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }
});
