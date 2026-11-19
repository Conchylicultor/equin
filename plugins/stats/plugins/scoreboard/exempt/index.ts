import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["machine/internal/served.ts"],
    kind: "sanctioned",
    reason:
      "stats.scoreboard is a snapshot (load: \"snapshot\"): measured when a reader opens it or presses Refresh, never notified and never kept fresh by a change source. Its truth is a day-level trend over main's boot log, main's git history and tables the change feed excludes by declaration (the latency ledger's, the report history's); the live `reports` / `report_fixes` rows it joins only fill the days before the history tables existed. Nothing a write does needs to reach an open card before its next Refresh.",
  },
] satisfies Exemptions;
