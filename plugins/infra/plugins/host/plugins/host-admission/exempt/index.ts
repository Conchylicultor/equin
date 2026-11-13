import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "host-pools-declared",
    paths: ["server"],
    kind: "sanctioned",
    reason:
      "The registry: the one legitimate owner of createHostSemaphore, through which every host pool is declared (defineHostPool).",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/internal/budget.ts",
      "server/internal/pool.ts",
      "server/internal/fleet-memory.ts",
      "server/internal/holders.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "watcher-safety/no-raw-fs-watch",
    paths: ["server/internal/fleet-memory.ts"],
    kind: "sanctioned",
    reason:
      "A waiting cpu grant acquire follows the fleet memory reading (one file, renamed into place every 30 s by main's owner sampler) with ONE non-recursive, non-persistent fs.watch on its directory, open only while that acquire waits, so a widening window is taken at once. A defineFileWatcher cannot serve it: the grant is acquired by CLI processes (build, check, test, push) with no plugin runtime to mount a declaration in, and @parcel/watcher's native addon would join every CLI op's startup closure through this barrel — the same reason as the duress latch's watch.",
  },
] satisfies Exemptions;
