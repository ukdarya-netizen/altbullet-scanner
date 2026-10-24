import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RESTART_WINDOW_MS = 24 * 60 * 60 * 1000;
const RESTART_MIN_INTERVAL_MS = 12 * 60 * 1000;
const MAX_RESTARTS_PER_WINDOW = 12;
const BUDGET_PATH = join(tmpdir(), "altbullet-scanner-restart-budget.json");

type RestartBudgetState = {
  timestamps: number[];
};

export type ScannerRestartBudgetClaim =
  | {
      allowed: true;
      used: number;
      remaining: number;
    }
  | {
      allowed: false;
      reason: "cooldown" | "limit";
      used: number;
      retryAt: Date | null;
    };

function readBudgetState(): RestartBudgetState {
  try {
    if (!existsSync(BUDGET_PATH)) return { timestamps: [] };
    const parsed = JSON.parse(readFileSync(BUDGET_PATH, "utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as RestartBudgetState).timestamps)
    ) {
      return { timestamps: [] };
    }
    return {
      timestamps: (parsed as RestartBudgetState).timestamps.filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      ),
    };
  } catch {
    return { timestamps: [] };
  }
}

function writeBudgetState(state: RestartBudgetState): void {
  const temporaryPath = `${BUDGET_PATH}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporaryPath, BUDGET_PATH);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

/**
 * Survives a supervised process restart on a Reserved VM, so a stuck
 * scheduler control-plane cannot turn the liveness probe into a restart loop.
 */
export function claimScannerRestartBudget(
  now = Date.now(),
): ScannerRestartBudgetClaim {
  const state = readBudgetState();
  const timestamps = state.timestamps.filter(
    (timestamp) => now - timestamp < RESTART_WINDOW_MS,
  );
  const latest = timestamps.at(-1) ?? null;

  if (latest !== null && now - latest < RESTART_MIN_INTERVAL_MS) {
    return {
      allowed: false,
      reason: "cooldown",
      used: timestamps.length,
      retryAt: new Date(latest + RESTART_MIN_INTERVAL_MS),
    };
  }
  if (timestamps.length >= MAX_RESTARTS_PER_WINDOW) {
    return {
      allowed: false,
      reason: "limit",
      used: timestamps.length,
      retryAt: new Date(timestamps[0] + RESTART_WINDOW_MS),
    };
  }

  timestamps.push(now);
  writeBudgetState({ timestamps });
  return {
    allowed: true,
    used: timestamps.length,
    remaining: MAX_RESTARTS_PER_WINDOW - timestamps.length,
  };
}
