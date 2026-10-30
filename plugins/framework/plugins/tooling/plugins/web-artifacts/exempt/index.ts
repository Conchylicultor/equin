import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/hash.ts",
      "core/internal/browser-hosts.ts",
      "core/internal/compose.ts",
      "core/internal/expected.ts",
      "core/internal/global-css.ts",
      "core/internal/identity.ts",
      "core/internal/lease.ts",
      "core/internal/own-files.ts",
      "core/internal/package-assets.ts",
      "core/internal/pipeline.ts",
      "core/internal/plan.ts",
      "core/internal/precompress.ts",
      "core/internal/served-dists.ts",
      "core/internal/staged-verify.ts",
      "core/internal/store.ts",
      "core/internal/tailwind-candidates.ts",
      "core/internal/vendor-cache.ts",
      "core/internal/vendors.ts",
      "core/internal/vite-builder.ts",
      "core/internal/worker-link.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
