import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "import-scan-safety/no-hand-import-resolution",
    paths: ["core/vocabulary.ts"],
    kind: "sanctioned",
    reason:
      "Maps a declared barrel specifier to its PLUGIN's directory (the barrel folder dropped), to tell which plugins own the resource vocabulary \u2014 a plugin path, never a module file, so there is no import to resolve.",
  },
] satisfies Exemptions;
