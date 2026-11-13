import type { StorageFailure } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { report } from "@plugins/reports/web";

// The handler of the web-storage primitive's `storageFailureReportSink`,
// drained through a `ReportSinks.Collector` keyed by
// `primitives.dom.web-storage` (so it ships only where the primitive does).
// The web-storage primitive must not import `reports`, so it emits a neutral
// `StorageFailure` into a module-level sink; this maps each one to a crash
// report.
//
// Every failure is filed: a refused write is a value the user loses on reload
// (a cap sized too small, or something filling the area); a corrupt entry is
// our own bytes failing our own schema; an entry another schema wrote is
// version skew or an unmigrated schema change — the engine tells which. The errorType carries owner +
// reason and no stack, so a burst of refusals is ONE deduped row whose count
// climbs — and a toast nobody saw still reaches Debug → Reports.
export function collectStorageFailure(f: StorageFailure): void {
  void report({
    kind: "crash",
    // An entry another build's schema wrote is its own source: the
    // reports engine judges it by the tab's bundle (version skew from an
    // outdated tab, an unmigrated older schema from a current one).
    source:
      f.reason === "other-schema"
        ? "client-storage-other-schema"
        : "client-storage",
    message:
      f.reason === "corrupt"
        ? `web-storage: an entry of ${f.owner} (${f.area}) failed the schema that wrote it and was dropped`
        : f.reason === "other-schema"
          ? `web-storage: an entry of ${f.owner} (${f.area}) written under another schema cannot be read by this build (kept in place)`
          : `web-storage: ${f.owner} (${f.area}) write refused: ${f.reason}${f.error ? ` (${f.error})` : ""}`,
    url: window.location.href,
    userAgent: navigator.userAgent,
    data: { errorType: `WebStorage:${f.reason}:${f.owner}`, stack: null },
  });
}
