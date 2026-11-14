import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["machine/internal/write-all.ts"],
    kind: "sanctioned",
    reason:
      "The synchronous stdout / stderr writer by definition: its callers (a CLI's transcript echo, a build verdict printed in an exit handler right before process.exit) need every byte out before they return, which no async write can promise. It writes to a terminal or pipe a CLI owns, never to disk from a backend's request path.",
  },
] satisfies Exemptions;
