import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/reset.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "boot:closure-digestable",
    paths: ["server/index.ts"],
    kind: "debt",
    task: "task-1793843090-eqagj3",
    reason:
      "Its reset path reaches codegen's barrel, which loads modules by computed paths.",
  },
] satisfies Exemptions;
