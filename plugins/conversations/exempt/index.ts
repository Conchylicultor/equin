import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "ids:pk-declared",
    paths: [
      "server/internal/tables-created-event.ts",
      "server/internal/tables-turn-completed-event.ts",
    ],
    kind: "debt",
    task: "task-1791405297096-jyzsmk",
    reason:
      "A trigger table built by infra/events' defineTriggerEvent, whose shared column set (events/server/internal/base-columns.ts) keys every *_triggers table by a bare uuid. Phase 6 of the unified prefixed ids keys them all at once (uuid -> text + a declared kind) in that one file; delete this entry then.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/lifecycle.ts",
      "server/internal/locate-cut.ts",
      "server/internal/status-reconciler.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
