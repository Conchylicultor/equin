import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useAppExclusions } from "@plugins/plugin-meta/plugins/composition/web";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-view/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const blockIcon = symbol("block");

/**
 * Marks a row the app does not ship — the tree lists every plugin on disk, and
 * this is the one thing on the row that says whether it is actually in the
 * running app.
 *
 * Two labels, and the difference is a real one for whoever is reading:
 * *Not in the app* is a decision someone wrote down (a manifest negated this id
 * by name, in practice on the `base-exclusions` row every composition
 * inherits), while *Not in the app (cascade)* is a consequence — the plugin
 * descends from, or imports, one of those, so it could not stay.
 *
 * Deliberately NOT the sibling `membership` tint: that one colours rows by the
 * composition draft you are currently EDITING, this one answers what the built
 * app contains. Same tree, two different questions.
 */
export function ExcludedBadge({ node }: { node: PluginNode }) {
  const exclusions = useAppExclusions();
  // Until the graph and manifests resolve, nothing is known about this row —
  // rendering nothing would be the claim "this plugin ships", which is what the
  // majority of rows will settle on and so reads as an answer. The block variant
  // only paints after ~120ms, so a warm cache never flashes it.
  if (exclusions.kind === "pending") {
    // Hidden from assistive tech: one row's placeholder is not news, and the
    // tree paints dozens at once — a `role="status"` per visible row would be
    // dozens of "Loading" announcements for a single pending fetch.
    return (
      <span aria-hidden>
        <Loading variant="block" className="size-3.5 rounded-full" />
      </span>
    );
  }
  // A failed graph read is not "ships": the row says it could not tell, with
  // the read's Retry, rather than a pending block that never resolves.
  if (exclusions.kind === "failed") {
    return (
      <ResourceErrorInline
        variant="icon"
        subject="whether the app ships this plugin"
        error={exclusions.error}
        refetch={exclusions.refetch}
      />
    );
  }
  if (!exclusions.excluded.has(node.id)) return null;
  const label = exclusions.negatedTargets.has(node.id)
    ? "Not in the app"
    : "Not in the app (cascade)";
  return (
    <Icon
      icon={blockIcon}
      className="size-3.5 text-muted-foreground"
      aria-label={label}
    />
  );
}
