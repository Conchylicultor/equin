import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "page-hosts-on-demand",
    paths: ["web/index.ts"],
    kind: "sanctioned",
    reason:
      "Unreachable on the standalone website: the live demo's user config is a fresh memory store propagated from the committed layer (config_v2/browser-store), so no document there can be in conflict — the only refusal this toast says.",
  },
] satisfies Exemptions;
