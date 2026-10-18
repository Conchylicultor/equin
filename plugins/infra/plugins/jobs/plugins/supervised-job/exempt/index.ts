import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "spawn-safety/no-raw-bun-spawn",
    paths: ["server/internal/run/supervisor.ts"],
    kind: "sanctioned",
    reason:
      "The supervised-run primitive, and the one place `detached: true` is meant to be written. Every property that makes it exempt is the point of it: the child outlives the call BY DESIGN (that is what surviving a backend restart means), its stdout and stderr are a caller-owned file descriptor rather than temp files read after exit, and its output is published while it runs by tailing that file. As build, release and deploy migrate onto it, their three entries below are deleted — the exemption converges on this one line instead of spreading.",
  },
  {
    rule: "ids:pk-declared",
    paths: ["server/internal/tables.ts"],
    kind: "debt",
    task: "task-1791405297096-jyzsmk",
    reason:
      "Phase-1 baseline of the unified prefixed ids: this table's `id` primary key names no id kind yet. Declare the kind (`defineIdKind`) and key the table with `idColumn` / `idKindField` (or `externalIdColumn` for an id minted elsewhere) in its migration phase, then delete this entry.",
  },
  {
    rule: "ids:pk-declared",
    paths: ["server/internal/tables-run-ended.ts"],
    kind: "debt",
    task: "task-1791405297096-jyzsmk",
    reason:
      "A trigger table built by infra/events' defineTriggerEvent, whose shared column set (events/server/internal/base-columns.ts) keys every *_triggers table by a bare uuid. Phase 6 of the unified prefixed ids keys them all at once (uuid -> text + a declared kind) in that one file; delete this entry then.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/internal/terminal.ts",
      "server/internal/run/supervisor.ts",
      "server/internal/run/tail.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
