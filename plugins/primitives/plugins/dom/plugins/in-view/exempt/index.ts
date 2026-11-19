import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "intersection-observer-safety/no-raw-intersection-observer",
    paths: ["web/internal/in-view.ts"],
    kind: "sanctioned",
    reason: "The in-view primitive is the one sanctioned home for the idiom.",
  },
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/internal/in-view.ts"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — useInView (an eslint-disable of a react-hooks rule in it makes the compiler skip it).",
  },
] satisfies Exemptions;
