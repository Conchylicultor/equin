import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "timer/no-unlisted-timer",
    paths: ["machine/internal/owner-sampler.ts"],
    kind: "sanctioned",
    reason:
      "A sampler of the host (every 30 s, beside health-monitor's 10 s host sampler): the per-owner breakdown must be recorded through a contention window, when the job queue it would ride is itself saturated.",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["machine/internal/fork-memory/entry.ts"],
    kind: "sanctioned",
    reason:
      "The fork-memory worker's entry: it runs on its own worker thread, off the backend's event loop — the reason it exists — so a synchronous read of a process's usage record stalls only the worker.",
  },
] satisfies Exemptions;
