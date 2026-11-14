import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "detached-work-safety/no-raw-set-interval",
    paths: ["bin/serve.ts"],
    kind: "sanctioned",
    reason:
      "Process entry points' orphan guards: they run before (and outside) the plugin graph that registers timers, and exit the process when its parent dies.",
  },
  {
    rule: "live/no-legacy-resource-spelling",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The substrate: defines the old live-resource spellings, or is compiled onto them (the live API, the optimistic overlay, the runtime and its server / central facades).",
  },
  {
    rule: "server-core/no-process-crash-listener",
    paths: ["core/process-crash-listeners.ts"],
    kind: "sanctioned",
    reason:
      "The one owner of the process's crash listeners: installed by each process entry point before the graph loads, dispatching to processCrashSink.",
  },
  {
    rule: "source-read-safety/no-text-source-read",
    paths: ["check/index.ts"],
    kind: "debt",
    task: "task-1794623832-1sr8c7",
    reason:
      "Written before sourceAnalysis(ctx): reads code through parse-utils' text helpers (regexes over masked source), which skip what they cannot guess.",
  },
] satisfies Exemptions;
