import assert from "node:assert/strict";

const { pool } = await import("@workspace/db");
const { claimPatternDecisionTrajectories } =
  await import("../src/lib/pattern-decision-history.js");

await pool.query(`
  CREATE TABLE pattern_decision_snapshots (
    id serial PRIMARY KEY,
    event_key text NOT NULL UNIQUE,
    symbol text NOT NULL,
    pattern_key text NOT NULL,
    decision_kind text NOT NULL,
    decision_reason text,
    decision_at timestamptz NOT NULL,
    entry_price real,
    source text NOT NULL,
    trajectory_status text NOT NULL DEFAULT 'pending',
    trajectory_attempts integer NOT NULL DEFAULT 0,
    trajectory_next_attempt_at timestamptz,
    trajectory_claim_token text,
    trajectory_claimed_at timestamptz,
    trajectory_claim_expires_at timestamptz
  );
  CREATE TABLE pattern_backfill_candles (
    id serial PRIMARY KEY,
    decision_snapshot_id integer NOT NULL,
    interval text NOT NULL DEFAULT '15m',
    candle_at timestamptz NOT NULL
  );
`);

type Seed = {
  eventKey: string;
  symbol: string;
  patternKey: string;
  decisionKind: string;
  decisionReason?: string;
  nextAttempt?: string;
  claimExpires?: string;
};

const seeds: Seed[] = [];
for (const pattern of ["balanced_grind", "impulse_buy"]) {
  const prefix = pattern === "balanced_grind" ? "bg" : "ib";
  seeds.push(
    {
      eventKey: `${prefix}:fired`,
      symbol: `${prefix.toUpperCase()}-FIRED`,
      patternKey: pattern,
      decisionKind: "fired",
    },
    {
      eventKey: `${prefix}:near`,
      symbol: `${prefix.toUpperCase()}-NEAR`,
      patternKey: pattern,
      decisionKind: "rejected",
      decisionReason:
        pattern === "balanced_grind"
          ? "early_gate+p24h_too_high=21pct"
          : "early_gate+spot_volume_above_2x=2.4",
    },
  );
  for (let index = 0; index < 40; index += 1) {
    seeds.push({
      eventKey: `${prefix}:sample:${index}`,
      symbol: `${prefix.toUpperCase()}-SAMPLE-${index}`,
      patternKey: pattern,
      decisionKind: "rejected",
      decisionReason: "early_low_value_gate",
    });
  }
}
seeds.push(
  {
    eventKey: "bg:leased",
    symbol: "BG-LEASED",
    patternKey: "balanced_grind",
    decisionKind: "fired",
    claimExpires: "2999-01-01T00:00:00.000Z",
  },
  {
    eventKey: "ib:not-due",
    symbol: "IB-NOT-DUE",
    patternKey: "impulse_buy",
    decisionKind: "fired",
    nextAttempt: "2999-01-01T00:00:00.000Z",
  },
);

for (const seed of seeds) {
  await pool.query(
    `INSERT INTO pattern_decision_snapshots (
      event_key, symbol, pattern_key, decision_kind, decision_reason,
      decision_at, entry_price, source, trajectory_next_attempt_at,
      trajectory_claim_expires_at
    ) VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', 1,
      'integration_test', $6, $7)`,
    [
      seed.eventKey,
      seed.symbol,
      seed.patternKey,
      seed.decisionKind,
      seed.decisionReason ?? null,
      seed.nextAttempt ?? null,
      seed.claimExpires ?? null,
    ],
  );
}

const first = await claimPatternDecisionTrajectories(4);
const firstSymbols = new Set(first.candidates.map((row) => row.symbol));
assert.deepEqual(
  firstSymbols,
  new Set(["BG-FIRED", "BG-NEAR", "IB-FIRED", "IB-NEAR"]),
);

const second = await claimPatternDecisionTrajectories(6);
const secondRows = await pool.query<{
  pattern_key: string;
  symbol: string;
}>(
  `SELECT pattern_key, symbol
   FROM pattern_decision_snapshots
   WHERE trajectory_claim_token = $1
   ORDER BY pattern_key, symbol`,
  [second.claimToken],
);
assert.equal(secondRows.rows.length, 6);
assert.equal(
  secondRows.rows.filter((row) => row.pattern_key === "balanced_grind").length,
  3,
);
assert.equal(
  secondRows.rows.filter((row) => row.pattern_key === "impulse_buy").length,
  3,
);
assert.ok(!firstSymbols.has("BG-LEASED"));
assert.ok(!firstSymbols.has("IB-NOT-DUE"));
assert.ok(!secondRows.rows.some((row) => row.symbol === "BG-LEASED"));
assert.ok(!secondRows.rows.some((row) => row.symbol === "IB-NOT-DUE"));

await pool.end();
