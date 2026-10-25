import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "product-name:legacy-id",
    paths: ["CLAUDE.md"],
    kind: "sanctioned",
    reason:
      "The generated plugin reference lists each FileExplorer.Places contribution by its id, and the repo checkout's place keeps its stored id (LEGACY_IDS.fileExplorerPlace).",
  },
] satisfies Exemptions;
