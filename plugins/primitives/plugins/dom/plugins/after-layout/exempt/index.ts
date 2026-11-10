import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "resize-observer-safety/no-raw-resize-observer",
    paths: ["web/internal/after-layout.ts"],
    kind: "sanctioned",
    reason:
      "The after-layout phase is triggered by a ResizeObserver delivery — the one point in a frame that runs after style and layout and before paint. It observes no element's size.",
  },
] satisfies Exemptions;
