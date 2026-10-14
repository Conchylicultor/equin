import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "scroll-safety/no-adhoc-scroll-into-view",
    paths: ["web/internal/use-reveal-on-active.ts"],
    kind: "sanctioned",
    reason:
      "The scroll-reveal primitive is the one sanctioned home for the idiom.",
  },
  {
    rule: "scroll-safety/no-adhoc-scroll-write",
    paths: ["web/internal/use-reveal-on-active.ts"],
    kind: "sanctioned",
    reason:
      'A reveal scoped to the nearest scroll container (`scope: "nearest"`) scrolls that one container directly — `scrollIntoView` would move every ancestor.',
  },
] satisfies Exemptions;
