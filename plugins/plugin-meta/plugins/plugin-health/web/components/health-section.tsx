import {
  SectionCount,
  type PluginNode,
} from "@plugins/plugin-meta/plugins/plugin-view/web";
import { useMemo } from "react";
import {
  combineResources,
  foldResource,
  mapResource,
  ResourceErrorInline,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  liveDataSource,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import {
  pluginHealthReviews,
  pluginStaleness,
  reviewTaskCounts,
  type PluginStaleness,
  type ReviewTaskCounts,
} from "../../shared/schemas";
import type { PluginHealthReview } from "../../core";

function StatusDot({ color }: { color: string }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

function healthColor(
  staleness: PluginStaleness,
  tasks: ReviewTaskCounts,
): string {
  if (staleness.commitsSince > 50 || tasks.open > 5) return "bg-destructive";
  if (staleness.commitsSince > 10 || tasks.open > 0) return "bg-warning";
  return "bg-success";
}

function findingsText({ open, dropped, held }: ReviewTaskCounts): string {
  if (open + dropped + held === 0) return "—";
  return (
    [
      open > 0 && `${open} open`,
      dropped > 0 && `${dropped} dropped`,
      held > 0 && `${held} held`,
    ]
      .filter(Boolean)
      .join(", ") || "all resolved"
  );
}

/**
 * A review's staleness (git, against main's HEAD) and its filed tasks' counts
 * are two live reads per row, each drawn in its own cell — loading while not
 * known, a failure (or a refusal: the stored commit is not one git can place)
 * in place of the value, never a stand-in number.
 */
function useReviewReads(review: PluginHealthReview) {
  const staleness = useLive(pluginStaleness, {
    pluginId: review.pluginId,
    commitHash: review.commitHash,
  });
  const tasks = useLive(reviewTaskCounts, { reviewId: review.id });
  return { staleness, tasks };
}

function HealthDotCell({ review }: { review: PluginHealthReview }) {
  const { staleness, tasks } = useReviewReads(review);
  return foldResource(combineResources({ staleness, tasks }), {
    loading: () => <StatusDot color="bg-muted-foreground/30" />,
    error: () => <StatusDot color="bg-muted-foreground/30" />,
    ready: (d) => <StatusDot color={healthColor(d.staleness, d.tasks)} />,
  });
}

function CommitsCell({ review }: { review: PluginHealthReview }) {
  const { staleness } = useReviewReads(review);
  return foldResource(staleness, {
    loading: () => <Loading label="…" />,
    error: (error) => (
      <ResourceErrorInline
        error={error}
        refetch={staleness.refetch}
        variant="inline"
      />
    ),
    ready: (s) => (
      <>
        {s.commitsSince}
        {s.apiChanged && (
          // eslint-disable-next-line spacing/no-adhoc-spacing -- ml-1 is a tiny inline offset for the trailing "API changed" asterisk after the commit count, not container rhythm
          <span className="ml-1 text-warning" title="API changed">
            *
          </span>
        )}
      </>
    ),
  });
}

function FindingsCell({ review }: { review: PluginHealthReview }) {
  const { tasks } = useReviewReads(review);
  return foldResource(tasks, {
    loading: () => <Loading label="…" />,
    error: (error) => (
      <ResourceErrorInline
        error={error}
        refetch={tasks.refetch}
        variant="inline"
      />
    ),
    ready: (counts) => <>{findingsText(counts)}</>,
  });
}

const REVIEWS_VIEW = defineDataView("plugin-health.reviews");

// One plugin's reviews, live: the collection's window scoped server-side to the
// plugin (`scoped`, per section). Nothing to search: a plugin has at most one
// review per axis.
const reviewsSource = liveDataSource(pluginHealthReviews, { searchable: [] });

// The collection's fields: the axis shows, the plugin id is the scope's.
const overrides = fieldOverrides(pluginHealthReviews, {
  axis: { primary: true },
  pluginId: { visible: false },
});

// What a row computes itself: the health dot, when it was reviewed, and the
// two live reads. The reads' cells sort, filter and group by nothing — their
// values live in the cells, not on the row.
const extraFields: FieldDef<PluginHealthReview>[] = [
  {
    id: "health",
    label: "",
    type: "text",
    width: "1.5rem",
    value: () => "",
    sortable: false,
    filterable: false,
    cell: (r) => <HealthDotCell review={r} />,
  },
  {
    id: "reviewed",
    label: "Reviewed",
    type: "date",
    value: (r) => r.createdAt,
    filterable: false,
    cell: (r) => <RelativeTime date={r.createdAt} />,
  },
  {
    id: "commits",
    label: "Commits",
    type: "text",
    value: () => "",
    sortable: false,
    filterable: false,
    cell: (r) => <CommitsCell review={r} />,
  },
  {
    id: "findings",
    label: "Findings",
    type: "text",
    value: () => "",
    sortable: false,
    filterable: false,
    cell: (r) => <FindingsCell review={r} />,
  },
];

function HealthSectionInner({ node }: { node: PluginNode }) {
  const source = useMemo(
    () => reviewsSource.scoped({ where: { pluginId: node.id } }),
    [node.id],
  );
  return (
    <DataView<PluginHealthReview>
      storageKey={REVIEWS_VIEW}
      source={source}
      overrides={overrides}
      extraFields={extraFields}
      views={["table"]}
      density="compact"
      emptyState="No reviews."
    />
  );
}

/**
 * This plugin's reviews, live: the collection's default window filtered
 * server-side to `node.id`. The count and the availability gate read this one
 * query (one subscription between them); the section's DataView reads its own
 * window over the same scope (its sort and limit), a second subscription. The
 * default window's limit bounds nothing here: a plugin has at most one review
 * per axis.
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
  return <HealthSectionInner node={node} />;
}
