import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "scroll-safety/no-adhoc-scroll-write",
    paths: ["core/frame-agent.ts"],
    kind: "sanctioned",
    reason:
      "The frame agent runs inside a content document on another origin — serialized into it, importing nothing — and restores that document's own scroll offsets when the canvas reloads a prototype (what auto-scroll's document-scroll carry did while the frame was same-origin). It cannot reach the scroll-owning primitive from there.",
  },
] satisfies Exemptions;
