import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "live-state/no-handrolled-result",
    paths: ["web/components/git-fields.tsx"],
    kind: "sanctioned",
    reason:
      "The client-fields resolver answers a ResourceResult composed of TWO reads (the folder's checkout, then that checkout's status) plus a settled 'not a checkout' state that has no read behind it; no single read to map from.",
  },
] satisfies Exemptions;
