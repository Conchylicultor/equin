import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "live-state/no-handrolled-result",
    paths: ["web/components/git-fields.tsx"],
    kind: "sanctioned",
    reason:
      "The client-fields resolver answers a ResourceResult composed of TWO reads (the folder's checkout, then that checkout's status) plus a settled 'not a checkout' state that has no read behind it; no single read to map from.",
  },
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["machine/internal/ignored.ts"],
    kind: "sanctioned",
    reason:
      "A live read of ANY checkout the user browses (no pass holds its set), scoped by literal pathspecs to the few entries of ONE listed folder git's exclude rules matched — never a whole-tree listing.",
  },
] satisfies Exemptions;
