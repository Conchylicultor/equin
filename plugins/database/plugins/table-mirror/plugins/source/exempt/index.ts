import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "sql-writes:fit:hand-written",
    paths: ["server/internal/triggers.ts"],
    kind: "sanctioned",
    reason:
      "The change-log trigger functions are plpgsql generated from each mirror set's declaration: a set-based INSERT … SELECT from a statement's transition table into table_mirror_log, which only runs inside the trigger — no typed builder can express it.",
  },
] satisfies Exemptions;
