import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "element-fullscreen/no-raw-request-fullscreen",
    paths: ["web/internal/fullscreen-support.ts"],
    kind: "sanctioned",
    reason:
      "The primitive's one request, reachable only from the supported arm of fullscreenSupport(doc).",
  },
] satisfies Exemptions;
