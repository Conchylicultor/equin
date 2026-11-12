import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/served.ts"],
    kind: "sanctioned",
    reason:
      "deploymentSessions is a snapshot external: the truth is the deployed site's own data, read over SSH, with no change signal here. `hostOnlyQueryOverSsh` (deploy/host-query) reads the deployment's SSH target from Postgres (row, server, pinned host key, key secret) inside the loader — the private key may only be read at SSH time — and re-reads it on every measure, so it is never staler than the snapshot the value already says is re-measured only on ask. A `db` arm would label it fresh, and `reads` is a notified value's.",
  },
] satisfies Exemptions;
