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
      "A backend loads this module, and its blocking functions do not carry the *Sync name yet: a method bound by an interface others implement, an async function that does sync work inside, or a cascade (data-root resolution) left for the redesign.",
  },
] satisfies Exemptions;
