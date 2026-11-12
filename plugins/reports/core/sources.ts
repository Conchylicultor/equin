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
  // The database lock watch (database/lock-watch): a session held others back,
  // or sat idle inside a transaction, past its bound. A scheduled observation
  // of the database, not an error anyone caught.
  "server-db-lock-watch",
  // Main's daily upstream check: the repo this checkout was cloned from has
  // commits local `main` does not. Its own source because nothing failed — it
  // is a scheduled observation of another repository, not an error anyone
  // caught.
  "server-upstream-monitor",
  // The host file-I/O detector (infra/host/io-health): the fs-latency
  // monitor's log showed a sustained degradation of this machine's disk or
  // file system. A scheduled observation of the host, not an error anyone caught.
  "server-host-io-monitor",
  // A whole live set (network/live `all: { unbounded: { reason, budget } }`)
  // loaded past its declared budget: its reason no longer holds.
  "server-live-set-budget",
  "server-cost-monitor",
  // Model discovery (conversations/model-provider/catalog): the Claude CLI's
  // model menu named something outside the model id grammar, or left out a
  // family. An observation of the bundled Claude Code, not an error anyone caught.
  "server-model-discovery",
  // The compaction-context delivery check (conversations/compaction-context/
  // delivery-check): an agent's transcript shows that the context handed back
  // after a compaction did not reach it whole — the Claude CLI cut the hook's
  // output. An observation of the bundled Claude Code, not an error anyone caught.
  "server-compaction-context",
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
  // An error a deployed website's anonymous VISITOR hit, pulled from the site's
  // box by the computer (apps/deploy/site-reports/import). Server-only so the
  // browser endpoint cannot claim it, and untrusted
  // (UNTRUSTED_REPORT_SOURCES): strangers wrote its content.
  "website-visitor",
] as const;
export const CLIENT_REPORT_SOURCES = [
  "browser-error",
  "browser-rejection",
  "react-boundary",
  "client-endpoint",
  "live-state-wedge",
  "client-slow-op",
  "client-render-loop",
  // A browser tab's main thread froze (reports/main-thread-stall): filed by a
  // live tab of the origin on the frozen one's behalf.
  "client-main-thread-stall",
  // A click / key press whose next paint came late (reports/main-thread-stall's
  // slow interactions), filed by the tab itself.
  "client-slow-interaction",
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
  // An open popover's anchor left the document or went display: none
  // (reports/popover-anchor-lost).
  "client-popover-anchor-lost",
  // A dispatch slot fell back inside a PluginScope though the page holds a
  // matching contribution the scope dropped (reports/scoped-out-dispatch).
  "client-scoped-out-dispatch",
  "client-collab-hydration",
  "client-page-undo-conflict",
  "client-theme-resolution",
  // A symbol drawn in the scope of a strict icon family that does not map it
  // (reports/icon-family-gap): the scope shows the family's gap glyph.
  "client-icon-family-gap",
  // A held icon sprite without the symbol an <Icon> draws
  // (reports/icon-missing-glyph): the build's icon manifest missed the name.
  "client-icon-missing-glyph",
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
