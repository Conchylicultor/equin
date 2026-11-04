import type { ReactNode } from "react";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import type { LiveRowResult } from "./use-live";

export interface RowViewProps<Row> {
  /** A by-id row read: `useLive(c, { id })`. */
  row: LiveRowResult<Row>;
  /** Only ever called with the row — found, or as last seen on a failed re-read. */
  children: (row: Row) => ReactNode;
  /**
   * Rendered when the read answered and there is no such row (never seen, or
   * deleted while shown). Required: an absent row is an answer, and drawing it
   * as loading is a spinner that never ends.
   */
  missing: ReactNode;
  /** Rendered while loading. Default: `<Loading/>`. */
  fallback?: ReactNode;
  /**
   * What the failed read is about, for the default error block (`the agent`).
   * A failed re-read that already saw the row keeps rendering it.
   */
  subject?: string;
}

/**
 * Exhaustive render-match over a by-id row read — the `ResourceView` of
 * `useLive(c, { id })`, for a surface no pane resolve guard answers for: every
 * arm has its own rendering, and not-found cannot fall into loading's.
 */
export function RowView<Row>({
  row,
  children,
  missing,
  fallback,
  subject,
}: RowViewProps<Row>): ReactNode {
  switch (row.status) {
    case "loading":
      return fallback === undefined ? <Loading /> : fallback;
    case "error":
      if (row.stale !== undefined) return children(row.stale);
      return (
        <ResourceErrorInline
          variant="block"
          subject={subject}
          error={row.error}
          refetch={row.refetch}
        />
      );
    case "ready":
      return row.found ? children(row.row) : missing;
  }
}
