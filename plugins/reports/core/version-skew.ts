import type { CLIENT_REPORT_SOURCES } from "./sources";

// When a report from an outdated tab is version skew — and when it is not.
// Imports nothing at runtime: the noise reconcile digests this module's code
// (`versionSkewCode`), so the stored `noise` flags are re-judged exactly when
// this judgment changes — and only then.

/**
 * What a client report is evidence about, and so whether the tab that filed it
 * running an outdated bundle can explain it.
 *
 * - `load` — the tab loading what the server serves NOW with the bundle it
 *   booted: a chunk of its graph, the boot snapshot's values, an entry another
 *   build stored. Its graph and the server's no longer match, so the outdated
 *   bundle may be the whole cause, and reloading the tab the whole fix. The
 *   ONLY subject version skew can explain.
 * - `page` — the tab's own code doing something by itself: an exception, a
 *   render loop, a stall, a layout gone wrong. Its age explains none of it: a
 *   bug in an old bundle is a bug in that code, live in every tab still
 *   running it. Whether a newer build fixed it is the fix ledger's question
 *   (`--fixes-report`, judged on commits: an occurrence from code without
 *   the fix is no regression), never a guess from the build id — which
 *   differs on almost every tab, since main deploys on every push.
 * - `server` — what the tab observed the SERVER do (or not do): a sub left
 *   unanswered, a loader that failed, a 5xx, a write it refused. A tab on an
 *   old bundle still gets an answer to everything it asks (an unknown key is
 *   a `sub-error` the Reload advice handles, never filed), so the bundle's age
 *   explains none of it either.
 *
 * A `Record` over every client source, so a new source states its subject.
 */
export const CLIENT_REPORT_SUBJECT: Record<
  (typeof CLIENT_REPORT_SOURCES)[number],
  "load" | "page" | "server"
> = {
  "browser-error": "page",
  "browser-rejection": "page",
  "react-boundary": "page",
  // A 5xx (the server failed) or a validation 400 (the server refused the
  // write — the user's edit is lost either way).
  "client-endpoint": "server",
  "live-state-wedge": "server",
  "client-slow-op": "page",
  "client-render-loop": "page",
  "client-main-thread-stall": "page",
  "client-slow-interaction": "page",
  // Server truth superseded an acked op / the server refused one for good.
  "client-optimistic-divergence": "server",
  "client-optimistic-rejection": "server",
  "client-turn-unconfirmed": "server",
  // Bodies judged stale by the DATA's version / boot epoch, not the bundle's.
  "client-live-state-stale-drop": "server",
  // A live read's loader failed or found nothing (`client-outdated` is the
  // Reload advice's, never filed).
  "client-resource-error": "server",
  "client-caret-flight": "page",
  "client-adaptive-bar": "page",
  "client-viewport-escape": "page",
  "client-panel-overflow": "page",
  "client-popover-anchor-lost": "page",
  "client-scoped-out-dispatch": "page",
  "client-tool-input-drift": "page",
  "client-collab-hydration": "page",
  "client-page-undo-conflict": "page",
  "client-theme-resolution": "page",
  "client-icon-family-gap": "page",
  "client-icon-missing-glyph": "page",
  "boot-snapshot": "load",
  "client-boot-task": "page",
  "client-boot-crash": "page",
  "client-missing-companion": "page",
  "plugin-load": "load",
  "client-storage": "load",
};

/**
 * The FACT of one occurrence: the reporting tab's bundle (its graph hash,
 * `buildId`) is not the graph this server serves. Says nothing about whether
 * that explains the report — {@link versionSkewMayExplain} does.
 */
export function fromOutdatedBundle(occurrence: {
  buildId: string | null | undefined;
  serverGraph: string | null;
}): boolean {
  const { buildId, serverGraph } = occurrence;
  return buildId != null && serverGraph != null && buildId !== serverGraph;
}

/**
 * Whether version skew may explain a report: every occurrence it has came from
 * an outdated tab (`staleOrigin`, the row's fact — cleared for good by one
 * occurrence from a tab on the served graph) AND it is about the tab loading
 * what the server serves now (`load`, {@link CLIENT_REPORT_SUBJECT}). The one
 * judgment the stale-frontend noise rule, the bell's "(stale tab)" and the
 * crash task's origin line read.
 */
export function versionSkewMayExplain(report: {
  source: string;
  staleOrigin: boolean;
}): boolean {
  if (!report.staleOrigin) return false;
  // A server source carries no bundle; it is never `load`.
  const subjects: Partial<Record<string, "load" | "page" | "server">> =
    CLIENT_REPORT_SUBJECT;
  return subjects[report.source] === "load";
}

/** This module, for the noise reconcile's code digest. */
export const versionSkewCode = import.meta;
