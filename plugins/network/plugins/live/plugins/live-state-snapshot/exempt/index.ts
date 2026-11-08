import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "sql-writes:fit:hand-written",
    paths: [
      "server/internal/changelog-horizon.ts",
      "server/internal/handoff.ts",
    ],
    kind: "sanctioned",
    reason:
      "Each is one data-modifying CTE (prune the changelog and raise its horizon; replace the epoch handoff row) so the two writes are atomic in one statement with no idle-in-transaction window.",
  },
  {
    rule: "sql-writes:fit:hand-written",
    paths: ["server/internal/tables-ddl.ts"],
    kind: "sanctioned",
    reason:
      "Seeds the changelog horizon's singleton row in the same boot DDL that creates the imperative table.",
  },
  {
    rule: "sql-writes:fit:hand-written",
    paths: ["server/internal/persist.ts", "server/internal/produced-guard.ts"],
    kind: "debt",
    task: "task-1794169943-tteke4",
    reason:
      "live_state_snapshot is made by imperative DDL at boot (derived state, not a migration), so it has no typed write handle; these upserts and deletes are fit-checked against that DDL.",
  },
] satisfies Exemptions;
