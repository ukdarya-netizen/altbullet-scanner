import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const watcherSource = readFileSync(
  new URL("../src/lib/watcher.ts", import.meta.url),
  "utf8",
);
const closeDbSource = readFileSync(
  new URL("../src/lib/impulse-runner-close-db.ts", import.meta.url),
  "utf8",
);

test("open Impulse Buy runners recover pending deliveries before claiming the next milestone", () => {
  const helper = watcherSource.match(
    /async function processImpulseRunnerMilestone\([\s\S]*?\n}\n\n\/\/ ── Add signal/,
  )?.[0];

  assert.ok(helper, "runner milestone helper must exist");
  assert.match(helper, /retryPendingMilestoneNotification\(/);
  assert.match(helper, /nextMilestone\(/);
  assert.match(helper, /pendingMilestone} IS NULL/);
  assert.match(helper, /coreClosedAt} IS NOT NULL/);
  assert.match(helper, /runnerState} = 'open'/);
  assert.match(helper, /queueReachedMilestoneAfterClaim\(/);
});

test("both fast-cycle and realtime runner paths continue milestone delivery", () => {
  const fastRunnerBranch = watcherSource.match(
    /if \(tracked\.status === "in_run" && isImpulseRunnerCoreClosed\(tracked\)\) \{[\s\S]*?\n      }\n      const activatedTrailingStop/,
  )?.[0];
  assert.ok(fastRunnerBranch);
  assert.match(fastRunnerBranch, /closeImpulseRunnerFinalPosition\(/);
  assert.match(fastRunnerBranch, /processImpulseRunnerMilestone\(/);

  const realtimeRunnerContinuation = watcherSource.match(
    /if \(outcome\) \{[\s\S]*?currentCandidate\.lastEventAt = eventAt;/,
  )?.[0];
  assert.ok(realtimeRunnerContinuation);
  assert.match(
    realtimeRunnerContinuation,
    /isImpulseRunnerCoreClosed\(outcome\.tracked\)/,
  );
  assert.match(realtimeRunnerContinuation, /processImpulseRunnerMilestone\(/);
});

test("runner milestones are queued atomically and final close does not erase pending state", () => {
  const coreClose = watcherSource.match(
    /async function closeImpulseRunnerCorePosition\([\s\S]*?\n}\n\nasync function closeImpulseRunnerFinalPosition/,
  )?.[0];
  assert.ok(coreClose);
  assert.match(coreClose, /tracked\.pendingMilestone != null/);
  assert.match(coreClose, /claimImpulseRunnerCoreClose\(/);
  assert.match(closeDbSource, /coreClosedAt} IS NULL/);
  assert.match(closeDbSource, /pendingMilestone} IS NULL/);

  const finalClose = watcherSource.match(
    /async function closeImpulseRunnerFinalPosition\([\s\S]*?\n}\n\n\/\*\*/,
  )?.[0];
  assert.ok(finalClose);
  assert.match(finalClose, /claimImpulseRunnerFinalClose\(/);
  assert.match(
    watcherSource,
    /queueReachedMilestoneAfterClaim\([\s\S]*?milestoneOutboxEventKey/,
  );
  const finalCloseDb = closeDbSource.match(
    /export async function claimImpulseRunnerFinalClose\([\s\S]*$/,
  )?.[0];
  assert.ok(finalCloseDb);
  assert.doesNotMatch(finalCloseDb, /pendingMilestone: null/);
  assert.doesNotMatch(finalCloseDb, /pendingMilestoneStatus: null/);
  assert.match(closeDbSource, /END\)::tracked_status/);
});

test("normal milestones claim economic state and Telegram outbox in one transaction", () => {
  const helper = watcherSource.match(
    /async function queueReachedMilestoneAfterClaim\([\s\S]*?\n}\n\nasync function retryPendingMilestoneNotification/,
  )?.[0];
  assert.ok(helper);
  assert.match(helper, /broadcastPhotoAfterClaim\(/);
  assert.match(helper, /milestoneOutboxEventKey/);

  const normalMilestone = watcherSource.match(
    /const reachedMilestone = nextMilestone\(tracked\.lastMilestone, pnl\);[\s\S]*?FastCycle: MILESTONE 🎯/,
  )?.[0];
  assert.ok(normalMilestone);
  assert.match(normalMilestone, /queueReachedMilestoneAfterClaim\(/);
  assert.match(normalMilestone, /async \(tx\)/);
  assert.match(normalMilestone, /pendingMilestone} IS NULL/);
  assert.doesNotMatch(normalMilestone, /buildPendingMilestoneState/);
  assert.doesNotMatch(normalMilestone, /finishMilestoneNotification/);
});

test("BR recovery uses per-milestone transactional pending-recipient delivery", () => {
  assert.match(watcherSource, /BR_MISSED_MILESTONES/);
  assert.match(
    watcherSource,
    /broadcastPhotoAfterClaim\([\s\S]*brMilestoneEventKey\(milestone\)/,
  );
  assert.match(
    watcherSource,
    /trackedSignalsTable\.signalId[\s\S]*trackedSignalsTable\.detectedAt[\s\S]*trackedSignalsTable\.policyVersion/,
  );
  assert.match(watcherSource, /void enqueueBrMissedMilestones\(\)/);
  assert.match(
    watcherSource,
    /for \(const milestone of BR_MISSED_MILESTONES\)/,
  );
  assert.match(watcherSource, /catch \(err\) \{[\s\S]*continuing sequence/);
});

test("startup clears impossible pending milestone state from terminal positions", () => {
  const cleanup = watcherSource.match(
    /async function clearTerminalPendingMilestoneState\(\)[\s\S]*?\n}\n\nexport function startWatcher/,
  )?.[0];

  assert.ok(cleanup);
  assert.match(cleanup, /pendingMilestone: null/);
  assert.match(cleanup, /status} NOT IN \('active', 'in_run'\)/);
  assert.match(
    watcherSource,
    /"terminal-pending-milestone-cleanup"[\s\S]*?clearTerminalPendingMilestoneState/,
  );
});
