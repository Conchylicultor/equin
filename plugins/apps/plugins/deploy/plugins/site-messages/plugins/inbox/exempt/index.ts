import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/served.ts"],
    kind: "sanctioned",
    reason:
      "siteMessagesInbox reads this computer's copy of a deployed site's site_messages: a table-mirror replica schema (tm_*), which the change feed deliberately excludes (no triggers outside public). Its change signal is the mirror's own — every applied page NOTIFYs table_mirror in its transaction, and onSiteMirrorApplied hands that to the collection's notify — so the external arm with changes: \"notified\" is the one that can see a write. Besides the copy it reads only the replica's state row (table_mirror_replicas, inside withReplicaSchema's snapshot), which the same NOTIFY covers.",
  },
] satisfies Exemptions;
