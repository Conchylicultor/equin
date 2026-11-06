import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/latch.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["server/internal/latch.ts"],
    kind: "debt",
    task: "task-1793970457-7rrcc4",
    reason:
      "isUnderDuress() / duressEpisode() are a synchronous gate read from many synchronous hot paths (log-channel ingress, the shed buffer's admit, the latency-ledger recorder, the CLI admission valve), so they stat/read the latch file on the calling thread (memoized 2 s). The fix is a redesign: serve them from an in-process value pushed by a watch on the latch dir (lapse computed from the held mtime against the clock), with a fresh async read for the woken CLI valve. The writers (setDuress / refreshDuress / clearDuress, and readDuress) run on the sentinel's own worker thread, plus tests.",
  },
] satisfies Exemptions;
