import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/authored-override-seed.ts",
      "core/barrel-stubs-gen.ts",
      "core/claude-settings-gen.ts",
      "core/config-origin-gen.ts",
      "core/custom-utilities-gen.ts",
      "core/data-views-gen.ts",
      "core/declared-apps.ts",
      "core/docgen.ts",
      "core/evaluated-barrels.ts",
      "core/fields-eager-gen.ts",
      "core/file-scans.ts",
      "core/git-layer-config.ts",
      "core/icon-manifest-gen.ts",
      "core/import-graph.ts",
      "core/override-legend-stamp.ts",
      "core/package-names.ts",
      "core/pre-barrel-guard.ts",
      "core/slot-declaration-guard.ts",
      "core/space-ramp-gen.ts",
      "core/test-helpers-doc.ts",
      "core/write-generated.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "marker-scan-safety/no-adhoc-marker-scan",
    paths: ["core/browser-host-coverage.ts"],
    kind: "sanctioned",
    reason:
      "Token-in-string: the browser-host coverage guard finds a raw `/api/<prefix>` URL a scoped page builds by hand, which lives inside a string literal (passed to fetch, or an element's src) with no enclosing marker call — a full mask would erase it. Comments are still masked, and only a literal STARTING with `/api/` counts, so a route string or prose naming one is no URL.",
  },
  {
    rule: "user-path/no-unproven-claim",
    paths: ["core/test-helpers-doc.ts"],
    kind: "sanctioned",
    reason:
      "a relative import specifier read from a testing barrel of the checkout's own plugins, resolved against the barrel that names it",
  },
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["core/barrel-free-tree.ts", "core/evaluated-barrels.ts"],
    kind: "debt",
    task: "task-1793856387-73tcw0",
    reason:
      "The codegen tree family lists the repo itself when its caller hands no set (the barrel-free tree), per evaluation phase (the build must re-read the tree after each phase writes generated files), and synchronously for collected-dir discovery \u2014 ~3 whole-tree listings per check pass, memoized per process.",
  },
] satisfies Exemptions;
