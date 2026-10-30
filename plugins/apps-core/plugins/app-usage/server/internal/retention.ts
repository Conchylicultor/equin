import { defineRetention } from "@plugins/infra/plugins/retention/server";
import { _appUsageDaily } from "./tables";

// The growth bound: rows per day are bounded by the app registry, and the TTL
// bounds the days. Two years keeps a long "all time" while the table stays at
// most ~730 × (apps) rows. Main-only (the default): the table lives in main's DB.
export const appUsageRetention = defineRetention({
  table: _appUsageDaily,
  column: "lastFlushedAt",
  ttlDays: 730,
});
