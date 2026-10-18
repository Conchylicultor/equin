import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "repo-walk-safety/no-adhoc-repo-walk",
    paths: ["core/internal/global-css.ts"],
    kind: "sanctioned",
    reason:
      "`global-css` collects each plugin's own stylesheet from the plugin tree.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/hash.ts",
      "core/internal/compose.ts",
      "core/internal/expected.ts",
      "core/internal/global-css.ts",
      "core/internal/identity.ts",
      "core/internal/own-files.ts",
      "core/internal/pipeline.ts",
      "core/internal/plan.ts",
      "core/internal/staged-verify.ts",
      "core/internal/store.ts",
      "core/internal/vendor-cache.ts",
      "core/internal/vendors.ts",
      "core/internal/vite-builder.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
