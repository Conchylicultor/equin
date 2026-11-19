import { defineRetention } from "@plugins/infra/plugins/retention/server";
import {
  _latencyLedgerClientMinute,
  _latencyLedgerDay,
  _latencyLedgerHostDay,
  _latencyLedgerHostMinute,
  _latencyLedgerInteraction,
  _latencyLedgerMinute,
  _latencyLedgerThreadMinute,
} from "./tables";

// The growth bounds. Each minute table is bounded by construction (rows per day
// do not grow with traffic); the TTL bounds the days. 35 days covers the track's
// 7-day exit window with room to compare before/after a change. `perWorktree`:
// the tables live in each backend's own database, so each sweeps its own.
export const minuteRetention = defineRetention({
  table: _latencyLedgerMinute,
  column: "minuteStart",
  ttlDays: 35,
  perWorktree: true,
});
export const clientMinuteRetention = defineRetention({
  table: _latencyLedgerClientMinute,
  column: "minuteStart",
  ttlDays: 35,
  perWorktree: true,
});
export const hostMinuteRetention = defineRetention({
  table: _latencyLedgerHostMinute,
  column: "minuteStart",
  ttlDays: 35,
  perWorktree: true,
});
export const threadMinuteRetention = defineRetention({
  table: _latencyLedgerThreadMinute,
  column: "minuteStart",
  ttlDays: 35,
  perWorktree: true,
});
export const interactionRetention = defineRetention({
  table: _latencyLedgerInteraction,
  column: "occurredAt",
  ttlDays: 14,
  perWorktree: true,
});

// The day rollups are a few hundred rows a day: kept a year and more, so a trend
// can be read across seasons of the app, long after the minutes are gone.
export const dayRetention = defineRetention({
  table: _latencyLedgerDay,
  column: "day",
  ttlDays: 400,
  perWorktree: true,
});
export const hostDayRetention = defineRetention({
  table: _latencyLedgerHostDay,
  column: "day",
  ttlDays: 400,
  perWorktree: true,
});
