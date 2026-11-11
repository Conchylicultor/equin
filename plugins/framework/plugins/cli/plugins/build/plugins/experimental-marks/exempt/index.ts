import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "page-hosts-on-demand",
    paths: ["web/index.ts"],
    kind: "sanctioned",
    reason:
      "The marks belong to an experimental build of the page's own document; the standalone website is never stamped experimental, so its page has none to show or hide.",
  },
] satisfies Exemptions;
