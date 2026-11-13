import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "import-scan-safety/no-hand-import-resolution",
    paths: ["core/specifier.ts"],
    kind: "sanctioned",
    reason:
      "The one import resolver: the plugin-records module graph resolves every edge with it, and a reader holding a specifier the graph has no edge for (an `import type`, a CSS `@import`, a declared barrel) resolves it with the same function.",
  },
] satisfies Exemptions;
