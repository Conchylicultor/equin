import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "import-scan-safety/no-hand-import-resolution",
    paths: ["core/vocabulary.ts"],
    kind: "sanctioned",
    reason:
      "Maps a declared barrel specifier to its PLUGIN's directory (the barrel folder dropped), to tell which plugins own the resource vocabulary \u2014 a plugin path, never a module file, so there is no import to resolve.",
  },
  {
    rule: "source-read-safety/no-text-source-read",
    paths: ["check/index.ts"],
    kind: "debt",
    task: "task-1794623832-1sr8c7",
    reason:
      "Written before sourceAnalysis(ctx): reads code through parse-utils' text helpers (regexes over masked source), which skip what they cannot guess.",
  },
] satisfies Exemptions;
