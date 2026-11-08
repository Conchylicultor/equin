import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["shared/digest.ts"],
    kind: "sanctioned",
    reason:
      "Reads the running checkout's own source files (node:fs, node:crypto, Bun.Transpiler, Bun.resolveSync): a digest of code on disk exists only on a host that runs from source, and its consumers (corpus-index, live-state-snapshot's machine half, restart-skip's backend and central halves) are desktop-only. In shared/ so the server and central barrels serve the one walk. The source sets themselves are portable data in core/.",
  },
  {
    rule: "blocking-fs/sync-named",
    paths: ["shared/digest.ts"],
    kind: "debt",
    task: "task-1793991095-ppkf09",
    reason:
      "walkClosure resolves each import with Bun.resolveSync while a backend digests a closure: needs an async resolver (an async realpath walk of node_modules plus the @plugins/* paths), or the walk off the thread.",
  },
] satisfies Exemptions;
