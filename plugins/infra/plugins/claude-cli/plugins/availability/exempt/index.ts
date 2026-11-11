import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "page-hosts-on-demand",
    paths: ["web/index.ts"],
    kind: "sanctioned",
    reason:
      "Machine-only (agent-runtime, excluded from the standalone website): a public site's visitor has no Claude CLI on a computer to recheck.",
  },
] satisfies Exemptions;
