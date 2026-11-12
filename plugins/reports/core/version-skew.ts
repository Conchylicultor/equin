import type { CLIENT_REPORT_SOURCES } from "./sources";

// When a report from an outdated tab is version skew — a judgment of FACTS,
// never of the report's words nor a guess from its source. Imports nothing at
// runtime: the noise reconcile digests this module's code (`versionSkewCode`),
// so the stored `noise` flags are re-judged exactly when this judgment
// changes — and only then.
//
// Main deploys on every push, so nearly every long-lived tab runs an outdated
// bundle — and an outdated bundle explains nothing by itself: a bug in an old
// bundle's code, or in what the server did for it, is a bug. A report is
// version skew only when its occurrence PROVES it, by the proof its source
// declares ({@link SKEW_PROOF}).

/**
 * What proves version skew for a client source — a `Record` over every client
 * source, so a new source states it.
 *
 * - `retired-file` — a module load failed (`plugin-load`). The browser's
 *   message reads the same for a file a rebuild retired, a network error while
 *   the gateway restarts and a server failing to serve a file it should, so
 *   two witnesses, neither trusted alone:
 *   - the TAB names the file its failed load needed (`ReportBody.missingFile`):
 *     it walked the failing module's own import graph and the server answered
 *     404 for that file — not a network error, not a 5xx, not "every file is
 *     served" (then the load failed for another reason: a bug);
 *   - the SERVER re-checks it (build/server-build-id's `isRetiredBuildFile`):
 *     the file is absent from what it serves AND the tab's build graph was
 *     retired. A 404 for a build still retained is a retention bug — loud.
 * - `outdated-tab` — the report is ABOUT the tab's bundle being another
 *   build's, so the bundle comparison is the proof (`fromOutdatedBundle`): an
 *   entry another build's schema stored (`client-storage-other-schema`; the
 *   entry is left in place). An outdated tab meeting a newer build's entry is
 *   expected; from a tab on the served graph it is a build that neither reads
 *   nor migrates its own old data — loud.
 * - `none` — nothing proves skew: loud from every tab. A failed boot snapshot
 *   included: a tab boots from the page the server serves, so its age is no
 *   proof of anything.
 */
export const SKEW_PROOF: Record<
  (typeof CLIENT_REPORT_SOURCES)[number],
  "retired-file" | "outdated-tab" | "none"
> = {
  "browser-error": "none",
  "browser-rejection": "none",
  "react-boundary": "none",
  "client-endpoint": "none",
  "live-state-wedge": "none",
  "client-slow-op": "none",
  "client-render-loop": "none",
  "client-main-thread-stall": "none",
  "client-slow-interaction": "none",
  "client-optimistic-divergence": "none",
  "client-optimistic-rejection": "none",
  "client-turn-unconfirmed": "none",
  "client-live-state-stale-drop": "none",
  "client-resource-error": "none",
  "client-caret-flight": "none",
  "client-adaptive-bar": "none",
  "client-viewport-escape": "none",
  "client-panel-overflow": "none",
  "client-popover-anchor-lost": "none",
  "client-scoped-out-dispatch": "none",
  "client-tool-input-drift": "none",
  "client-collab-hydration": "none",
  "client-page-undo-conflict": "none",
  "client-theme-resolution": "none",
  "client-icon-family-gap": "none",
  "client-icon-missing-glyph": "none",
  "boot-snapshot": "none",
  "client-boot-task": "none",
  "client-boot-crash": "none",
  "client-missing-companion": "none",
  "plugin-load": "retired-file",
  "client-storage": "none",
  "client-storage-other-schema": "outdated-tab",
};

/** The proof a source declares; a server source never proves skew. */
export function skewProofOf(
  source: string,
): "retired-file" | "outdated-tab" | "none" {
  const proofs: Partial<
    Record<string, "retired-file" | "outdated-tab" | "none">
  > = SKEW_PROOF;
  return proofs[source] ?? "none";
}

/**
 * The FACT of one occurrence: the reporting tab's bundle (its graph hash,
 * `buildId`) is not the graph this server serves. Says nothing about whether
 * that explains the report — it never does alone ({@link versionSkewExplains}).
 */
export function fromOutdatedBundle(occurrence: {
  buildId: string | null | undefined;
  serverGraph: string | null;
}): boolean {
  const { buildId, serverGraph } = occurrence;
  return buildId != null && serverGraph != null && buildId !== serverGraph;
}

/**
 * Whether version skew explains a report: every occurrence it has proved it,
 * by its source's {@link SKEW_PROOF} (`skewProven`, the row's sticky fact —
 * cleared for good by one occurrence that proved nothing).
 * The one judgment the stale-frontend noise rule, the bell's "[Stale tab]" and
 * the crash task's origin line read.
 */
export function versionSkewExplains(report: { skewProven: boolean }): boolean {
  return report.skewProven;
}

/** This module, for the noise reconcile's code digest. */
export const versionSkewCode = import.meta;
