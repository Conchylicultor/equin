import { useEffect } from "react";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import { registerModelCorruptionReporter } from "../../core";
import { report } from "@plugins/reports/web";

/**
 * Routes malformed stored-model signals into the visible crash-report
 * pipeline. Mounted once via Core.Root at app startup; installs the sink so an
 * unparseable persisted model surfaces as a real reported browser crash (deduped
 * per distinct value in core) rather than a buried console.error line.
 */
export function ModelCorruptionReporter() {
  useEffect(() => {
    registerModelCorruptionReporter((message) => {
      const err = new Error(message);
      err.name = "CorruptModelError";
      void report({
        kind: "crash",
        source: "browser-error",
        message: err.message,
        url: window.location.href,
        userAgent: navigator.userAgent,
        data: crashFieldsOf(err),
      });
    });
    return () => registerModelCorruptionReporter((m) => console.error(m));
  }, []);

  return null;
}
