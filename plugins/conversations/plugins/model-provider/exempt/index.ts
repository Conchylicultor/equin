import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "page-hosts-on-demand",
    paths: ["web/index.ts"],
    kind: "sanctioned",
    reason:
      "conversations is agent-runtime, which the standalone website excludes, so the page cannot hold it. Inside the live demo a malformed stored model falls back to console.error; the demo's stored models are its build-time seed, which the demo e2e scripts cover.",
  },
] satisfies Exemptions;
