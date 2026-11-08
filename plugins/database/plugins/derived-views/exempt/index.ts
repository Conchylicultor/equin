import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "sql-writes:fit:hand-written",
    paths: ["server/internal/rebuild.ts"],
    kind: "debt",
    task: "task-1794169943-tteke4",
    reason:
      "derived_view_state is made by imperative DDL at boot (derived state, not a migration), so it has no typed write handle; its one upsert is fit-checked against that DDL.",
  },
] satisfies Exemptions;
