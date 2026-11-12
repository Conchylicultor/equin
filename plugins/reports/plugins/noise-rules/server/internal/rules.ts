import type { ReportNoiseRuleSpec } from "@plugins/reports/server";

// The rules themselves, in a module that imports nothing but types: each rule's
// `code` is this module, and the engine reclassifies every stored report when
// the code it loads changes — an import here would make every change to the
// imported module re-run that reclassification.
//
// A rule judges a FACT about the report, never its message text: a bug is
// never muted. The 2026-11-12 audit removed every rule that matched words
// (the browser's "ResizeObserver loop" warning — its regression to 190/day went
// unnoticed because it was muted; a Claude Code child that exited 143/137 —
// a kill is a cause to find, and 137 is also an OOM or a malware-scan kill) or
// a guess the producer made (a live-state wedge "explained" by a restart or by
// the page being hidden — hidden pages kept measuring real server hangs). What
// such a producer cannot establish, it no longer reports at all.

// A report version skew explains — PROVEN, not guessed (reports/core's
// versionSkewExplains): every occurrence proved it by its source's proof — a
// failed module load by a file of the tab's build the server answered 404 for
// and confirmed retired; another build's stored entry by the tab being
// outdated. Reloading is the whole fix, and the tab already tells its user so.
// A load that failed with every file served, a network error, a 5xx, a failed
// boot snapshot: never — whatever tab filed them. Record + file the task, mute
// the notification.
export const staleFrontendRule: ReportNoiseRuleSpec = {
  id: "stale-frontend",
  matches: (i) => i.versionSkew,
  code: import.meta,
};
