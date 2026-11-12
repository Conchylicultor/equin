import type { ReportNoiseRuleSpec } from "@plugins/reports/server";

// The rules themselves, in a module that imports nothing but types: each rule's
// `code` is this module, and the engine reclassifies every stored report when
// the code it loads changes — an import here would make every change to the
// imported module re-run that reclassification.

export const resizeObserverRule: ReportNoiseRuleSpec = {
  id: "resize-observer",
  matches: ({ message, errorType }) =>
    message.toLowerCase().includes("resizeobserver") ||
    (errorType?.toLowerCase().includes("resizeobserver") ?? false),
  code: import.meta,
};

// A one-shot generation whose Claude Code exited 143/137 was killed by a
// signal (SIGTERM/SIGKILL) — a server restart during build. Not a real
// failure, just an interrupted throwaway generation. Mute so shutdowns
// don't spam crash tasks.
export const claudeCliSignalKillRule: ReportNoiseRuleSpec = {
  id: "claude-cli-signal-kill",
  matches: ({ errorType, message }) =>
    errorType === "ClaudeCliError" &&
    /Claude Code process exited with code (?:143|137)\b/.test(message),
  code: import.meta,
};

// A report version skew may explain: only ever seen from tabs on an obsolete
// bundle, and about such a tab loading what the server serves now (a chunk,
// the boot snapshot, an entry another build stored) — reloading is the whole
// fix. Never a bug in the tab's own code nor what it saw the server do
// (reports/core's versionSkewMayExplain). Record + file the task, mute the
// notification.
export const staleFrontendRule: ReportNoiseRuleSpec = {
  id: "stale-frontend",
  matches: (i) => i.versionSkew,
  code: import.meta,
};

// A live-state wedge the watchdog attributed to a server restart (its
// discriminator ends `:restart`): missed updates while the tab was
// backgrounded across one, or a handshake held while the server booted.
// Benign deploy-skew, not a stuck pipeline — and the build-id check above
// can't catch it, because such a tab is still on the build the server is
// currently serving. Or to a page suspension (`:suspended`): the wait it
// measured spanned a time the page was hidden, frozen by the browser (a phone
// locking its screen). Record + file the task, mute the notification.
export const liveStateWedgeRestartRule: ReportNoiseRuleSpec = {
  id: "live-state-wedge-restart",
  matches: ({ errorType }) =>
    errorType?.startsWith("LiveStateWedge:") === true &&
    (errorType.endsWith(":restart") || errorType.endsWith(":suspended")),
  code: import.meta,
};
