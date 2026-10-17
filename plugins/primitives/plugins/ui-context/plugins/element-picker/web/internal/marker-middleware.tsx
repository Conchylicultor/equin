import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { ReactNode } from "react";
import type { SlotItemAttrsFn } from "@plugins/primitives/plugins/slot-render/web";
import {
  PortalForwardProvider,
  usePortalForwardedAttrs,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ContributionNode } from "@plugins/primitives/plugins/ui-context/core";
import {
  appendLineage,
  contributionNodeAttrs,
  LINEAGE_ATTR,
} from "@plugins/primitives/plugins/ui-context/web";

/** The lineage node one contribution IS. Shared by the two halves below so the
 *  DOM stamp and the portal-forwarded chain can never describe it differently. */
function contributionNode(
  slotId: string,
  contribution: Contribution,
): ContributionNode {
  const pluginId = contribution._pluginId ?? "";
  const contributionId = contribution.id
    ? contribution._pluginId
      ? `${contribution._pluginId}:${contribution.id as string}`
      : String(contribution.id)
    : "";
  return { kind: "contribution", pluginId, slotId, contributionId };
}

/**
 * Marks every slot contribution with the owning plugin id and slot id (attribute
 * grammar owned by `primitives/ui-context`), so the `collectLineage` walk
 * resolves the nearest — most specific — plugin for any element.
 *
 * The marks are **attributes, not a wrapper**: they are handed to slot-render as
 * data and it stamps them on the one element it draws around each contribution.
 * A wrapper would land wherever this plugin happened to put it, and that is
 * exactly how the picker used to lie — the wrapper sat inside the layout cell a
 * row slot draws, so a click on the cell (all the slack around a small widget:
 * most of what there is to hit when the widget is a 4px progress bar in a 24px
 * row) climbed past the whole contribution and answered with the enclosing pane.
 * As data there is no placement to get right, here or in any future consumer.
 *
 * Contributed by the picker sub-plugin (a plain, non-companion contribution),
 * rather than by the `ui-context` barrel, keeps it opt-in: it describes *every* slot contribution repo-wide, and
 * that cost should only be paid when something that can pick is actually in
 * the app composition. `<UiRegion>` — a handful of explicit call sites — has
 * no such constraint and lives in the parent primitive.
 */
export const markerAttrs: SlotItemAttrsFn = ({
  slotId,
  contribution,
  boxless,
}) =>
  contributionNodeAttrs(contributionNode(slotId, contribution), { boxless });

/**
 * The portal half, which cannot be an attribute: a contribution that portals its
 * content out to `document.body` — popovers, dialogs, menus — severs DOM
 * ancestry, so the whole chain rides React context (which crosses portals) and
 * is re-stamped on the portaled positioner as {@link LINEAGE_ATTR}.
 *
 * A middleware because a provider has to wrap the children it serves. It renders
 * no element of its own.
 */
export function PluginMarkerMiddleware({
  slotId,
  contribution,
  children,
}: {
  slotId: string;
  contribution: Contribution;
  children: ReactNode;
}) {
  const inheritedLineage = usePortalForwardedAttrs()[LINEAGE_ATTR];
  const lineage = appendLineage(
    inheritedLineage,
    contributionNode(slotId, contribution),
  );
  return (
    <PortalForwardProvider name={LINEAGE_ATTR} value={lineage}>
      {children}
    </PortalForwardProvider>
  );
}
