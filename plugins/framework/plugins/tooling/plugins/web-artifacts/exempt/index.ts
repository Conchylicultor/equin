import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/hash.ts",
      "core/internal/browser-hosts.ts",
      "core/internal/compose.ts",
      "core/internal/global-css.ts",
      "core/internal/host-snapshots.ts",
      "core/internal/crawl-snapshot.ts",
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
  {
    rule: "user-path/no-unproven-claim",
    paths: [
      "core/internal/identity.ts",
      "core/internal/plan.ts",
      "core/internal/vendors.ts",
    ],
    kind: "sanctioned",
    reason:
      "a package file resolved from the checkout's own node_modules install (and, in vendors.ts, a re-export specifier such a package names, resolved against it)",
  },
  {
    rule: "user-path/no-unproven-claim",
    paths: ["core/internal/vendor-cache.ts"],
    kind: "sanctioned",
    reason:
      "paths this cache recorded itself when it built the vendor, under the checkout",
  },
  {
    rule: "user-path/no-unproven-claim",
    paths: [
      "core/internal/global-css.ts",
      "core/internal/package-assets.ts",
      "core/internal/staged-verify.ts",
    ],
    kind: "sanctioned",
    reason:
      "a relative import / url() specifier read from the checkout's own sources or its node_modules packages, resolved against the file that names it — or a path of the metafile esbuild wrote for the app's own vendor build, relative to its cwd",
  },
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["core/internal/pipeline.ts"],
    kind: "sanctioned",
    reason:
      "The build's artifact pipeline takes its snapshot after codegen and the formatter wrote, so every address is read off the tree the artifacts are built from \u2014 the build's own pass, once per run.",
  },
  {
    rule: "blocking-fs/sync-named",
    paths: [
      "core/internal/browser-hosts.ts",
      "core/internal/compose.ts",
      "core/internal/global-css.ts",
      "core/internal/host-snapshots.ts",
      "core/internal/crawl-snapshot.ts",
      "core/internal/identity.ts",
      "core/internal/lease.ts",
      "core/internal/package-assets.ts",
      "core/internal/pipeline.ts",
      "core/internal/plan.ts",
      "core/internal/precompress.ts",
      "core/internal/served-dists.ts",
      "core/internal/staged-verify.ts",
      "core/internal/store.ts",
      "core/internal/vendor-cache.ts",
      "core/internal/vendors.ts",
      "core/internal/vite-builder.ts",
      "core/internal/worker-link.ts",
    ],
    kind: "sanctioned",
    reason:
      "Host tooling only: no backend loads this module (blocking-fs:sync-named-reach measures the backends' import graph), so its blocking helpers hold only the CLI's, a check's or a script's own thread.",
  },
] satisfies Exemptions;
