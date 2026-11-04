import assert from "node:assert/strict";
import test from "node:test";
import { dbReadWithRetry } from "../src/lib/dbReadWithRetry.js";
import { dbWriteBestEffort, dbWriteStrict } from "../src/lib/dbWriteFast.js";

const never = <T>() => new Promise<T>(() => undefined);

test("best-effort writes do not multiply an orphaned request after timeout", async () => {
  let calls = 0;
  const result = await dbWriteBestEffort(
    "test/orphan-write",
    () => {
      calls++;
      return never<void>();
    },
    { attempts: 3, perAttemptTimeoutMs: 10, retryDelayMs: 1 },
  );

  assert.equal(result, null);
  assert.equal(calls, 1);
});

test("strict writes reject once instead of retrying an unknown write outcome", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      dbWriteStrict(
        "test/orphan-strict-write",
        () => {
          calls++;
          return never<void>();
        },
        { attempts: 3, perAttemptTimeoutMs: 10, retryDelayMs: 1 },
      ),
    /timed out/,
  );

  assert.equal(calls, 1);
});

test("reads stop retrying once the original request can still occupy the pool", async () => {
  let calls = 0;
  const result = await dbReadWithRetry(
    "test/orphan-read",
    () => {
      calls++;
      return never<void>();
    },
    3,
    1,
    10,
  );

  assert.deepEqual(result, { ok: false });
  assert.equal(calls, 1);
});
