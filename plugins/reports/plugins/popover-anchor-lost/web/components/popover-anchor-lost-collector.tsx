import { useEffect } from "react";
import { popoverAnchorLostSink } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { collectMeta } from "@plugins/primitives/plugins/ui-context/web";
import { report } from "@plugins/reports/web";
import type { PopoverAnchorLostPayload } from "@plugins/reports/plugins/popover-anchor-lost/core";

type ElementInfo = PopoverAnchorLostPayload["anchor"];

function infoOf(el: Element): ElementInfo {
  const meta = collectMeta(el);
  return {
    element: meta.element,
    path: meta.path,
    source: meta.source,
    owner: meta.owner,
    selector: meta.selector,
  };
}

// A Core.Root side-effect component. ui-kit must not import `reports` (nor
// ui-context, which is built on it), so its popover emits the lost anchor's
// ELEMENTS into a module-level sink; this component reads them — while they
// are still the live nodes — into a `kind: "popover-anchor-lost"` report. The
// same inversion viewport-escape and panel-overflow use. Renders nothing.
export function PopoverAnchorLostCollector() {
  useEffect(() => {
    popoverAnchorLostSink.register((d) => {
      const anchor = infoOf(d.anchor);
      const hiddenBy = d.hiddenBy ? infoOf(d.hiddenBy) : null;
      const why =
        d.cause === "detached"
          ? "was removed from the document"
          : hiddenBy
            ? `is hidden by ${hiddenBy.element} (display: none)`
            : "has no box (no display: none ancestor found)";
      const data = {
        cause: d.cause,
        popover: d.positioner
          ? infoOf(d.positioner)
          : { element: "unknown popover" },
        anchor,
        hiddenBy,
        message: `The anchor ${anchor.element} ${why} while its popover was open.`,
      } satisfies PopoverAnchorLostPayload;
      void report({
        kind: "popover-anchor-lost",
        source: "client-popover-anchor-lost",
        message: `Popover anchor lost: ${data.message}`,
        url: window.location.href,
        userAgent: navigator.userAgent,
        data,
      });
    });

    return () => {
      popoverAnchorLostSink.register(null);
    };
  }, []);

  return null;
}
