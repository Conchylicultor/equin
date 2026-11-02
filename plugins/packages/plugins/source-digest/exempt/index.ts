import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/digest.ts"],
    kind: "sanctioned",
    reason:
      "Reads the running checkout's own source files (node:fs, node:crypto, Bun.Transpiler, Bun.resolveSync): a digest of code on disk exists only on a host that runs from source, and its consumers (corpus-index, live-state-snapshot's machine half) are desktop-only. The source sets themselves are portable data in core/.",
  },
] satisfies Exemptions;
