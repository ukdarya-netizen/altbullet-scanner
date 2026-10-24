import {
  boolean,
  check,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { dashboardUsersTable } from "./signals";

/**
 * Personal replay parameters for the tracker trade calculator.
 * These values describe a model and are never used by the scanner or watcher.
 */
export const tradeCalculatorSettingsTable = pgTable(
  "trade_calculator_settings",
  {
    userId: integer("user_id")
      .primaryKey()
      .references(() => dashboardUsersTable.id, { onDelete: "cascade" }),
    depositUsdt: real("deposit_usdt").notNull().default(1000),
    leverage: real("leverage").notNull().default(10),
    allocationPercent: real("allocation_percent").notNull().default(10),
    commissionPercent: real("commission_percent").notNull().default(0.1),
    reinvest: boolean("reinvest").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "trade_calculator_settings_values_check",
      sql`${table.depositUsdt} BETWEEN 10 AND 10000000
        AND ${table.leverage} BETWEEN 1 AND 125
        AND ${table.allocationPercent} BETWEEN 0.1 AND 100
        AND ${table.commissionPercent} BETWEEN 0 AND 5`,
    ),
  ],
);

export const tradeCalculatorMonthlyTable = pgTable(
  "trade_calculator_monthly",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => dashboardUsersTable.id, { onDelete: "cascade" }),
    month: text("month").notNull(), // YYYY-MM in Asia/Dubai
    depositUsdt: real("deposit_usdt").notNull(),
    leverage: real("leverage").notNull(),
    allocationPercent: real("allocation_percent").notNull(),
    commissionPercent: real("commission_percent").notNull(),
    reinvest: boolean("reinvest").notNull().default(false),
    grossPnlUsdt: real("gross_pnl_usdt").notNull().default(0),
    netPnlUsdt: real("net_pnl_usdt").notNull().default(0),
    closedTrades: integer("closed_trades").notNull().default(0),
    profitTrades: integer("profit_trades").notNull().default(0),
    lossTrades: integer("loss_trades").notNull().default(0),
    buStopTrades: integer("bu_stop_trades").notNull().default(0),
    breakevenTrades: integer("breakeven_trades").notNull().default(0),
    expiredTrades: integer("expired_trades").notNull().default(0),
    cancelledSignals: integer("cancelled_signals").notNull().default(0),
    // NULL means the current rolling month; non-NULL marks an immutable
    // snapshot taken at the Dubai month boundary.
    periodClosedAt: timestamp("period_closed_at"),
    calculatedAt: timestamp("calculated_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("trade_calculator_monthly_user_month_unique").on(
      table.userId,
      table.month,
    ),
    check(
      "trade_calculator_monthly_settings_values_check",
      sql`${table.depositUsdt} BETWEEN 10 AND 10000000
        AND ${table.leverage} BETWEEN 1 AND 125
        AND ${table.allocationPercent} BETWEEN 0.1 AND 100
        AND ${table.commissionPercent} BETWEEN 0 AND 5`,
    ),
    check(
      "trade_calculator_monthly_month_check",
      sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    check(
      "trade_calculator_monthly_counts_check",
      sql`${table.closedTrades} >= 0
        AND ${table.profitTrades} >= 0
        AND ${table.lossTrades} >= 0
        AND ${table.buStopTrades} >= 0
        AND ${table.breakevenTrades} >= 0
        AND ${table.expiredTrades} >= 0
        AND ${table.cancelledSignals} >= 0
        AND ${table.closedTrades} = ${table.profitTrades} + ${table.lossTrades} + ${table.buStopTrades} + ${table.breakevenTrades} + ${table.expiredTrades}`,
    ),
  ],
);

export type TradeCalculatorSettings =
  typeof tradeCalculatorSettingsTable.$inferSelect;
export type InsertTradeCalculatorSettings =
  typeof tradeCalculatorSettingsTable.$inferInsert;
export type TradeCalculatorMonthly =
  typeof tradeCalculatorMonthlyTable.$inferSelect;
export type InsertTradeCalculatorMonthly =
  typeof tradeCalculatorMonthlyTable.$inferInsert;
