import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/live.ts"],
    kind: "debt",
    task: "task-1791766493-c5sz9f",
    reason:
      "The external `automations.catalog` loader reads `tasks_ext_origin` (`openAutomationTaskIds`) for each automation's open task, so `openTaskId` is fresh only while every writer remembers to `notify`. Derive that field from a db-served read instead of the external loader.",
  },
] satisfies Exemptions;
