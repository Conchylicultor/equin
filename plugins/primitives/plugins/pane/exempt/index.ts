import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "pane/no-core-define-route-in-web",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The plugin does not address itself through the cross-plugin specifier: its web/ files reach ../core relatively, and its jsdom suites drive the core barrel directly on purpose.",
  },
  {
    rule: "pane/no-pane-header-bar",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The pane header's own tier: PaneChrome and its FallbackChrome mirror (and the resolve guard's header) are the one place that draws `<Bar tier=\"pane\">`.",
  },
  {
    rule: "check-thread-safety/no-blocking-check-work",
    paths: ["check/identity-manifest.ts", "check/index.ts"],
    kind: "debt",
    task: "task-1793375830-dv7cez",
    reason:
      "Per-file synchronous work on the shared check thread (a blocking fs/process call made per item, or a direct maskSource / createSourceFile) that predates the rule; move it onto ctx.repo() / fs/promises and checks/core's maskedSource / parsedTsSource.",
  },
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["check/write-identity-snapshot.ts"],
    kind: "sanctioned",
    reason:
      "A standalone regenerator run by hand (`./equin run …/write-identity-snapshot.ts`), outside any check pass: it is its own pass root, lists the working tree once and hands that set to scanPaneIdentities.",
  },
  {
    rule: "react-compiler:no-silent-skips",
    paths: [
      "web/components/pane-chrome.tsx",
      "web/components/pane-resolve-guard.tsx",
      "web/components/promote-control.tsx",
      "web/pane.ts",
      "web/use-render-sync.ts",
    ],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — pane-chrome.tsx: PaneChrome (calls a hook carried as a value), PaneEndControls (calls a hook carried as a value); pane-resolve-guard.tsx: StickyResolveGuard (calls a hook carried as a value), FallbackChrome (calls a hook carried as a value); promote-control.tsx: ExpandElsewhere (calls a hook carried as a value), DefaultPromote (calls a hook carried as a value); pane.ts: useToggle (its hand-written memoization cannot be preserved), usePaneTitle (calls a hook carried as a value), useRoute and useIndexMatch (their memo lists the registry-version signal `contributions`, which they never read, under an exhaustive-deps disable — the compiler would drop it as a dep and a late-registered pane would never resolve); use-render-sync.ts: useRenderSync (reads a ref during render).",
  },
] satisfies Exemptions;
