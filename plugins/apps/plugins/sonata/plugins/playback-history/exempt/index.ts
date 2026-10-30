import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "endpoints/no-void-fetch-endpoint",
    paths: ["web/components/record-play-observer.tsx"],
    kind: "sanctioned",
    reason:
      "Play-count telemetry; an off-by-one on failure has no UX consequence.",
  },
] satisfies Exemptions;
