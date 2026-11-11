import { useEffect } from "react";
import { siteReportBatcher } from "../internal/channel";

/**
 * Headless (`Core.Root`, page): sends what the visit still holds when the page
 * goes away, with `keepalive` so the request outlives it.
 */
export function FlushReportsOnPagehide(): null {
  useEffect(() => {
    const onHide = () => {
      void siteReportBatcher.flush({ keepalive: true });
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);
  return null;
}
