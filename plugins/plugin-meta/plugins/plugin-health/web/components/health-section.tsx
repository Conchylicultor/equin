import { useEffect, useState } from "react";
import {
  SectionCount,
  type PluginNode,
} from "@plugins/plugin-meta/plugins/plugin-view/web";
import {
  foldResource,
  mapResource,
  ResourceView,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { getPluginStaleness, getPluginHealthTasks } from "../../core";
import { pluginHealthReviews } from "../../shared/schemas";
import type {
  PluginHealthReview,
  PluginStaleness,
  ReviewTaskSummary,
} from "../../core";

interface ReviewWithMeta {
  id: string;
  axis: string;
  commitHash: string;
  createdAt: Date;
  staleness?: PluginStaleness;
  tasks: ReviewTaskSummary[];
}

function StatusDot({ color }: { color: string }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

function healthColor(
  staleness: PluginStaleness | undefined,
  tasks: ReviewTaskSummary[],
): string {
  const openCount = tasks.filter((t) => t.status === "open").length;
  const commits = staleness?.commitsSince ?? 0;

  if (commits > 50 || openCount > 5) return "bg-destructive";
  if (commits > 10 || openCount > 0) return "bg-warning";
  return "bg-success";
}

function HealthSectionInner({
  reviews,
  node,
}: {
  reviews: PluginHealthReview[];
  node: PluginNode;
}) {
  const fetchEndpoint = useFetchEndpoint();
  const [enriched, setEnriched] = useState<ReviewWithMeta[]>([]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- async fetch+merge on live-state node.id/reviews change: setEnriched is driven by parallel staleness + per-review task reads; the cancelled-flag guards unmount/stale writes. No deriving-in-render path exists (the data is fetched, not pushed), and a single live read cannot express the per-review Promise.all fan-out. */
    if (reviews.length === 0) {
      setEnriched([]);
      return;
    }

    let cancelled = false;

    void (async () => {
      const [stalenessRes, ...taskResults] = await Promise.all([
        // read-only per-tab view refresh on live-state change; each tab renders its own enriched view, no cross-tab write to deduplicate
        fetchEndpoint(getPluginStaleness, { pluginId: node.id }),
        ...reviews.map((r) =>
          // read-only per-tab view refresh on live-state change; each tab renders its own enriched view, no cross-tab write to deduplicate
          fetchEndpoint(getPluginHealthTasks, { reviewId: r.id }),
        ),
      ]);

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set to true in useEffect cleanup
      if (cancelled) return;

      const stalenessMap = new Map(stalenessRes.map((s) => [s.axis, s]));

      setEnriched(
        reviews.map((r, i) => ({
          id: r.id,
          axis: r.axis,
          commitHash: r.commitHash,
          createdAt: r.createdAt,
          staleness: stalenessMap.get(r.axis),
          tasks: taskResults[i]!,
        })),
      );
    })();

    return () => {
      cancelled = true;
    };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [fetchEndpoint, node.id, reviews]);

  return (
    <Scroll axis="x">
      <table className="w-full text-2xs">
        <thead>
          <tr className="text-left text-muted-foreground/60">
            <th className="pb-xs pr-md font-medium" />
            <th className="pb-xs pr-md font-medium">Axis</th>
            <th className="pb-xs pr-md font-medium">Reviewed</th>
            <th className="pb-xs pr-md font-medium">Commits</th>
            <th className="pb-xs font-medium">Findings</th>
          </tr>
        </thead>
        <tbody>
          {enriched.map((r) => {
            const open = r.tasks.filter((t) => t.status === "open").length;
            const dropped = r.tasks.filter(
              (t) => t.status === "dropped",
            ).length;
            const held = r.tasks.filter((t) => t.status === "held").length;
            return (
              <tr key={r.id} className="border-t border-border/30">
                <td className="py-xs pr-sm">
                  <StatusDot color={healthColor(r.staleness, r.tasks)} />
                </td>
                <td className="py-xs pr-md font-medium text-foreground">
                  {r.axis}
                </td>
                <td className="py-xs pr-md text-muted-foreground">
                  <RelativeTime date={r.createdAt} />
                </td>
                <td className="py-xs pr-md text-muted-foreground">
                  {r.staleness?.commitsSince ?? "—"}
                  {r.staleness?.apiChanged && (
                    // eslint-disable-next-line spacing/no-adhoc-spacing -- ml-1 is a tiny inline offset for the trailing "API changed" asterisk after the commit count, not container rhythm
                    <span className="ml-1 text-warning" title="API changed">
                      *
                    </span>
                  )}
                </td>
                <td className="py-xs text-muted-foreground">
                  {r.tasks.length === 0
                    ? "—"
                    : [
                        open > 0 && `${open} open`,
                        dropped > 0 && `${dropped} dropped`,
                        held > 0 && `${held} held`,
                      ]
                        .filter(Boolean)
                        .join(", ") || "all resolved"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Scroll>
  );
}

/**
 * This plugin's reviews, live: the collection's window filtered server-side to
 * `node.id`. The count, the availability gate and the section all read this ONE
 * query, so they share one subscription.
 */
function usePluginReviews(node: PluginNode) {
  return useLive(pluginHealthReviews, { where: { pluginId: node.id } });
}

/**
 * How many health reviews this plugin has, as a read: loading and failed are
 * states, never a count. Collapsing "not known yet" into `0` would make a
 * reviewed plugin's card read as never-reviewed for the whole load window, and
 * would paint a literal "0" count beside the title.
 */
function useReviewCount(node: PluginNode): ResourceResult<number> {
  return mapResource(usePluginReviews(node), (reviews) => reviews.length);
}

/**
 * A never-reviewed plugin has no health to show — the host paints no card.
 *
 * While the count is unknown the section stays hidden. `useAvailable` returns a
 * boolean and so cannot express "not known yet"; of the two honest readings,
 * hiding-then-appearing costs a pop-in only on the few reviewed plugins, whereas
 * showing-then-vanishing would flash a card on every unreviewed one — and most
 * plugins are unreviewed. A FAILED read shows the card, so the section's own
 * error (with Retry) is on screen rather than the failure hiding the card.
 */
export function useHealthAvailable({ node }: { node: PluginNode }): boolean {
  return foldResource(useReviewCount(node), {
    loading: () => false,
    error: () => true,
    ready: (count) => count > 0,
  });
}

export function HealthCount({ node }: { node: PluginNode }) {
  const count = useReviewCount(node);
  // Nothing rather than "0" while the count is unknown; a failed read shows in
  // the section body, not in the title's count.
  switch (count.status) {
    case "loading":
    case "error":
      return null;
    case "ready":
      return <SectionCount>{count.data}</SectionCount>;
  }
}

export function HealthSection({ node }: { node: PluginNode }) {
  const reviewsResult = usePluginReviews(node);
  return (
    <ResourceView resource={reviewsResult}>
      {(reviews) => <HealthSectionInner reviews={reviews} node={node} />}
    </ResourceView>
  );
}
