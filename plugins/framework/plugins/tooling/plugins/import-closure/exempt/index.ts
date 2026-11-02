import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/import-closure.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "user-path/no-unproven-claim",
    paths: ["core/import-closure.ts"],
    kind: "sanctioned",
    reason:
      "A module Bun's bundler parsed from the app's own entrypoint graph: a file of the checkout or its node_modules install.",
  },
] satisfies Exemptions;
