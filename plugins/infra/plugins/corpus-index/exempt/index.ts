import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/corpus-index.ts", "server/internal/store.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "sink-safety/no-adhoc-file-sink",
    paths: ["server/internal/store.ts"],
    kind: "sanctioned",
    reason:
      "The index's entry log is bounded by construction: it is folded into a new snapshot (and unlinked) as soon as it outgrows the snapshot, so it never exceeds the index's own size. A rotating file sink would drop index records the snapshot does not hold yet.",
  },
] satisfies Exemptions;
