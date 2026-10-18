import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "timer/no-unlisted-timer",
    paths: ["server/internal/watchdog.ts"],
    kind: "sanctioned",
    reason:
      "The queue's alarm: a queued watchdog would sit in the backlog it exists to report (2026-08-17: eleven copies of it did).",
  },
] satisfies Exemptions;
