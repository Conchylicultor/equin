import { useEffect } from "react";
import { storageFailureReportSink } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { report } from "@plugins/reports/web";

// A Core.Root side-effect component. The web-storage primitive must not import
// `reports`, so it emits a neutral `StorageFailure` into a module-level sink;
// this component maps each one to a crash report. Renders nothing.
//
// Every failure is filed: a refused write is a value the user loses on reload
// (a cap sized too small, or something filling the area), and an unreadable
// entry is our own bytes failing our own schema. The errorType carries owner +
// reason and no stack, so a burst of refusals is ONE deduped row whose count
// climbs — and a toast nobody saw still reaches Debug → Reports.
export function StorageFailureCollector() {
  useEffect(() => {
    storageFailureReportSink.register((f) => {
      void report({
        kind: "crash",
        source: "client-storage",
        message:
          f.reason === "corrupt"
            ? `web-storage: an entry of ${f.owner} (${f.area}) failed its schema and was dropped`
            : `web-storage: ${f.owner} (${f.area}) write refused: ${f.reason}${f.error ? ` (${f.error})` : ""}`,
        url: window.location.href,
        userAgent: navigator.userAgent,
        data: { errorType: `WebStorage:${f.reason}:${f.owner}`, stack: null },
      });
    });
    return () => {
      storageFailureReportSink.register(null);
    };
  }, []);
  return null;
}
