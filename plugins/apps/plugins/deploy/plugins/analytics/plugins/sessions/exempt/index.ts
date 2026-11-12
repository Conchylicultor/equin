import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/served.ts"],
    kind: "sanctioned",
    reason:
      "deploymentSessions reads a site's copy of collect's tables in its replica schema (tm_*, table-mirror/replica), which the change feed does not cover: the replica's own NOTIFY (onReplicaApplied, sent in the transaction of every applied page) is its only change signal. The one public read — table_mirror_replicas, whether a whole copy is in place — moves in those same transactions.",
  },
] satisfies Exemptions;
