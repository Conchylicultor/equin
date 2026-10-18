// Report origins, split by who may report them. ReportSource is derived from the
// arrays so the union and the runtime allow-lists can never drift. Lives in
// core (not the plugin-private shared/) so cross-plugin recorders — e.g.
// slow-ops' record-slow-op — can narrow against the canonical union instead of
// re-declaring their own literal copy.
export const SERVER_REPORT_SOURCES = [
  "server-uncaught",
  "server-unhandled",
  "server-caught",
  "server-slow-op",
  "server-queue-monitor",
  "server-live-state-monitor",
  "server-op-rate-monitor",
  "server-read-set-monitor",
  "server-boot-budget-monitor",
  "server-boot-monitor",
  "server-boot-watchdog",
  "server-session-monitor",
  "server-transcript-watcher",
  "server-duress-shed",
  // The reports engine's own fan-out rollup: filed by recordReport when a kind
  // blows past its per-window distinct-fingerprint ceiling and the alerts are
  // collapsed into one accounting row.
  "server-report-storm",
  "server-duress-monitor",
  "server-stall-monitor",
  // Main's daily upstream check: the repo this checkout was cloned from has
  // commits local `main` does not. Its own source because nothing failed — it
  // is a scheduled observation of another repository, not an error anyone
  // caught.
  "server-upstream-monitor",
  "server-cost-monitor",
  // Model discovery (conversations/model-provider/catalog): the Claude CLI's
  // model menu named something outside the model id grammar, or left out a
  // family. An observation of the installed CLI, not an error anyone caught.
  "server-model-discovery",
  // The boot-time audit of this namespace's saved settings: some of the user's
  // own config overrides sit where no live config reads them any more (a plugin
  // was removed, or moved onto a destination that already had settings).
  "server-config-audit",
  // The Google place provider (page/place/google) was handed a place type its
  // copy of Google's Table A lacks. An observation of Google's taxonomy moving,
  // not an error anyone caught: the place still resolved.
  "server-place-google",
  // A report a backend filed synchronously on its way out of a DELIBERATE
  // `process.exit()` — not a crash (nothing threw) and not a caught error
  // (nobody is still running to catch it). Its own source because that
  // distinction is the whole content of the report: the process decided its
  // state was unrecoverable and said so before leaving.
  "server-fatal",
  // A report filed by a process with NO server — a CLI run, a supervised child —
  // through the report outbox (plugins/reports/plugins/outbox), and recorded by
  // main's drain. Server-only so the browser endpoint cannot claim it: nothing
  // over HTTP comes from a CLI.
  "cli",
] as const;
export const CLIENT_REPORT_SOURCES = [
  "browser-error",
  "browser-rejection",
  "react-boundary",
  "client-endpoint",
  "live-state-wedge",
  "client-slow-op",
  "client-render-loop",
  "client-optimistic-divergence",
  // The server permanently rejected an optimistic op or a detached write
  // (reports/optimistic-rejection) — the user's edit was lost.
  "client-optimistic-rejection",
  // Retired: the old pending-turn store's turn-unconfirmed reports. Nothing
  // files it now; kept so existing rows still parse.
  "client-turn-unconfirmed",
  "client-live-state-stale-drop",
  // A live read whose query gained an error (reports/resource-errors) — one per
  // failing (key, params) episode, however many hooks observe it.
  "client-resource-error",
  "client-caret-flight",
  "client-adaptive-bar",
  "client-viewport-escape",
  // A popover control panel whose page is wider than the panel
  // (reports/panel-overflow).
  "client-panel-overflow",
  "client-collab-hydration",
  "client-page-undo-conflict",
  "client-theme-resolution",
  "boot-snapshot",
  // A Core.Boot task failed or ran past App's boot deadline (web-core's
  // boot-tasks): the page is showing its boot waiting / error screen.
  "client-boot-task",
  // A companion the repo provides is missing from the running bundle once
  // every plugin loaded (web-sdk's `missingCompanions`): its owner degrades
  // with no error of its own.
  "client-missing-companion",
  "plugin-load",
  "client-storage",
] as const;
export type ReportSource =
  | (typeof SERVER_REPORT_SOURCES)[number]
  | (typeof CLIENT_REPORT_SOURCES)[number];
