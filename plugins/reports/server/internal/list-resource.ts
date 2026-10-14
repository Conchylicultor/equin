import { serveCollection } from "@plugins/network/plugins/live/server";
import { reportsList } from "../../core";
import { _reports } from "./tables";

// Server half of `reports.list`: the window, its `:rows` point reads and its
// `:groups` grouping, all from `reports`. Every declared field binds to the
// column of the same name, and the projection is exactly the schema's keys. No
// base `where` — a worktree's `reports` holds only its own rows (the table is
// excluded from the fork).
//
// Its changes arrive from the reports producer (./producer), never from a
// trigger: the routes this compiles are identity routes over `reports.id`, which
// carry no column, so the ids a producer emits are all they need (A3p).
export const reportsListServed = serveCollection(reportsList, {
  from: _reports,
});
