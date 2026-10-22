import type { ReactNode } from "react";
import {
  ResourceErrorInline,
  matchResource,
  type ResourceResult,
  type ResourceUnavailable,
} from "@plugins/primitives/plugins/live-state/web";
import { ChartState } from "./chart-primitives";

/** The chart box: its height on the stats grid, or the content's own. */
export type LiveChartSize = "sm" | "md" | "lg" | "content";

const SIZE_CLASS: Record<Exclude<LiveChartSize, "content">, string> = {
  sm: "h-56 w-full",
  md: "h-64 w-full",
  lg: "h-72 w-full",
};

/**
 * One Stats chart's frame over its live read — the one every Stats sub-plugin
 * uses: loading, the failure (with its subject and Retry), `unavailable` on a
 * host without the computer (a needsMachine read), `emptyText` when
 * `isEmpty` says there is nothing to plot — and only a ready, non-empty answer
 * reaches `children`.
 */
export function LiveChart<D>({
  read,
  subject,
  isEmpty,
  emptyText,
  size = "md",
  children,
}: {
  read: ResourceResult<D> | ResourceUnavailable;
  /** What failed to load, for the error message ("the commit counts"). */
  subject: string;
  /** Whether a ready answer has nothing to plot. Omitted: never empty. */
  isEmpty?: (data: D) => boolean;
  /** What this chart has none of ("No commits yet."). */
  emptyText: string;
  size?: LiveChartSize;
  children: (data: D) => ReactNode;
}) {
  // Every arm but `unavailable` carries the read's refetch (Retry).
  const refetch = read.status === "unavailable" ? undefined : read.refetch;
  const body = matchResource(read, {
    error: (error) => (
      <ResourceErrorInline
        variant="block"
        subject={subject}
        error={error}
        refetch={refetch}
      />
    ),
    ready: (data: D) => (
      <ChartState empty={isEmpty?.(data) ?? false} emptyText={emptyText}>
        {children(data)}
      </ChartState>
    ),
  });
  if (size === "content") return <>{body}</>;
  return <div className={SIZE_CLASS[size]}>{body}</div>;
}
