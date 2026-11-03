import { ExcludeFromChangeFeed } from "@plugins/network/plugins/live/plugins/change-feed/server";
import {
  ExcludeFromBackup,
  ExcludeFromFork,
} from "@plugins/database/plugins/admin/server";
import {
  _latencyLedgerHostMinute,
  _latencyLedgerInteraction,
  _latencyLedgerMinute,
  _latencyLedgerThreadMinute,
} from "./tables";
import { latencySummaryServed } from "./summary-resource";

// Observability about THIS machine in THIS database. Three consequences, the same
// for all four tables:
//  - no change feed: a write that happens every minute must not drive a live-state
//    recompute; the `latency-ledger.summary` value is served external and the
//    minute flush notifies it (./summary-resource);
//  - no fork: a worktree showing main's numbers as its own would be wrong;
//  - no backup: 35-day observability, not user data.
const ledgerTables = [
  _latencyLedgerMinute,
  _latencyLedgerHostMinute,
  _latencyLedgerThreadMinute,
  _latencyLedgerInteraction,
];

// Each feed exclusion names its table literally: the no-db-backed-notify check
// derives which tables this plugin may serve external from these `table:`
// identifiers, so a loop variable here would sanction nothing.
const feedReason =
  "Written every minute by the ledger itself; the latency-ledger.summary value is notified by the ledger's minute flush instead.";
const feedExclusions = [
  ExcludeFromChangeFeed({ table: _latencyLedgerMinute, reason: feedReason }),
  ExcludeFromChangeFeed({
    table: _latencyLedgerHostMinute,
    reason: feedReason,
  }),
  ExcludeFromChangeFeed({
    table: _latencyLedgerThreadMinute,
    reason: feedReason,
  }),
  ExcludeFromChangeFeed({
    table: _latencyLedgerInteraction,
    reason: feedReason,
  }),
];

const ledgerTablePolicies = ledgerTables.flatMap((table) => [
  ExcludeFromFork({
    table,
    reason:
      "Latency measured on the backend that wrote it; a fork showing main's numbers as its own would be wrong.",
  }),
  ExcludeFromBackup({
    table,
    reason: "35-day observability, swept nightly; not user data.",
  }),
]);

export const ledgerContributions = [
  ...latencySummaryServed.declare,
  ...feedExclusions,
  ...ledgerTablePolicies,
];
