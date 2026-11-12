import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["shared/digest.ts", "shared/resolve.ts", "shared/facts-store.ts"],
    kind: "sanctioned",
    reason:
      "Reads the running checkout's own source files (node:fs, node:crypto, Bun.Transpiler): a digest of code on disk exists only on a host that runs from source, and its consumers (corpus-index, live-state-snapshot's machine half, restart-skip's backend and central halves) are desktop-only. In shared/ so the server and central barrels serve the one walk. The source sets themselves are portable data in core/.",
  },
  {
    rule: "imperative-create-table-allowlisted",
    paths: ["shared/facts-store.ts"],
    kind: "sanctioned",
    reason:
      "The closure walk's facts store is a SQLite file under the data root (bun:sqlite), not a table of the app's Postgres database: the allowlist and the orphaned-db-tables check it feeds are about Postgres schema.",
  },
] satisfies Exemptions;
