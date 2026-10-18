import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "jobs:no-raw-addjob",
    paths: ["server/internal/cron-dedup.ts"],
    kind: "sanctioned",
    reason:
      "The cron-dedup regression harness: inserts a row under a literal job key an hour ahead, asserts graphile's upsert behaviour under the cron path's `job_key` / `job_key_mode`, and removes it. Driving `add_job` directly avoids a permanently-installed `* * * * *` schedule and a multi-minute wait.",
  },
  {
    rule: "endpoints:no-raw-json-handlers",
    paths: ["server/internal"],
    kind: "sanctioned",
    reason:
      "Long-poll / onDeadline test handlers with custom statuses and timeouts.",
  },
  {
    rule: "ids:pk-declared",
    paths: ["server/internal/tables.ts"],
    kind: "debt",
    task: "task-1791405297096-jyzsmk",
    reason:
      "A trigger table built by infra/events' defineTriggerEvent, whose shared column set (events/server/internal/base-columns.ts) keys every *_triggers table by a bare uuid. Phase 6 of the unified prefixed ids keys them all at once (uuid -> text + a declared kind) in that one file; delete this entry then.",
  },
  {
    rule: "live/no-endpoint-read",
    paths: ["web/components/events-test-view.tsx"],
    kind: "debt",
    task: "task-1791560308-woqgfi",
    reason:
      "A request/response server read (a GET fetchEndpoint or NDJSON stream an effect, a hook or a function they call runs) not yet moved onto a liveValue or liveCollection read with useLive.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/serial-queue.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
