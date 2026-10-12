import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "timer/no-unlisted-timer",
    paths: ["server/internal/watchdog.ts"],
    kind: "sanctioned",
    reason:
      "The queue's alarm: a queued watchdog would sit in the backlog it exists to report (2026-08-17: eleven copies of it did).",
  },
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/pulse.ts"],
    kind: "sanctioned",
    reason:
      "`queue-health.pulse` reads graphile-worker's tables (`graphile_worker.*`, through the jobs introspection API), a schema the DB change feed deliberately leaves out; the queue-activity signal and the verdict's next-change timer notify it instead.",
  },
] satisfies Exemptions;
