import { appendFile } from "node:fs/promises";

const logFile = process.env.OUTBOX_WORKER_LOG_FILE;
const barrierKey = process.env.OUTBOX_WORKER_BARRIER_KEY;
const workerId = process.env.OUTBOX_WORKER_ID;

globalThis.fetch = async (_input, init) => {
  if (logFile) {
    const body =
      typeof init?.body === "string"
        ? JSON.parse(init.body)
        : init?.body instanceof FormData
          ? {
              chat_id: init.body.get("chat_id"),
              caption: init.body.get("caption"),
              photo: init.body.get("photo"),
              multipart: true,
            }
          : {};
    await appendFile(
      logFile,
      `${JSON.stringify({ ...body, dispatched_at: Date.now() })}\n`,
      "utf8",
    );
  }
  return new Response(
    JSON.stringify({
      ok: true,
      result: { photo: [{ file_id: "worker-cached-photo-id" }] },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
};

const [{ drainTelegramPhotoOutbox }, { pool }] = await Promise.all([
  import("../src/lib/telegram-photo-outbox.js"),
  import("@workspace/db"),
]);

try {
  if (barrierKey && workerId) {
    await pool.query(
      `UPDATE outbox_test_barriers
       SET ready_count = ready_count + 1,
           released = (ready_count + 1 >= 2)
       WHERE barrier_key = $1`,
      [barrierKey],
    );
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const result = await pool.query(
        "SELECT released FROM outbox_test_barriers WHERE barrier_key = $1",
        [barrierKey],
      );
      if (result.rows[0]?.released === true) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const released = await pool.query(
      "SELECT released FROM outbox_test_barriers WHERE barrier_key = $1",
      [barrierKey],
    );
    if (released.rows[0]?.released !== true) {
      throw new Error("outbox worker barrier timed out");
    }
  }
  const dedupKey = process.env.OUTBOX_WORKER_DEDUP_KEY?.trim() || undefined;
  const delivered = await drainTelegramPhotoOutbox(dedupKey);
  console.log(JSON.stringify({ delivered }));
} finally {
  await pool.end();
}
