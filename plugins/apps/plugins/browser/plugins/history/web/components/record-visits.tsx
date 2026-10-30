import { useEffect } from "react";
import { useBrowserNav } from "@plugins/apps/plugins/browser/plugins/shell/web";
import { useRecordVisit } from "../internal/use-record-visit";

/**
 * Headless recorder: records every non-empty URL the browser navigates to. The
 * start page (`current === ""`) is never recorded. Renders nothing.
 */
export function RecordVisits(): null {
  const { current } = useBrowserNav();
  const record = useRecordVisit();

  useEffect(() => {
    if (current) void record(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- record only on URL change; the mutation fn identity is incidental
  }, [current]);

  return null;
}
