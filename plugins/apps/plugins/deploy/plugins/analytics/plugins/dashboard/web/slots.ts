import type { ComponentType } from "react";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { SiteExhibitState } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/site-row/web";

/** What a note beside the Visitors block's count is handed. */
export interface SiteVisitorsNoteProps {
  deploymentId: string;
  /** The link to the box is not live: the row shows what it last heard. */
  stale: boolean;
}

/**
 * One note after "312 today" in the deployed-site row's Visitors block
 * ("2 new messages"), contributed by the plugin that owns what it counts.
 * `exhibit` draws it for one of the row's exhibit states, from the owner's
 * own fixture. Renders `null` when it has nothing to say.
 */
export interface SiteVisitorsNote {
  component: ComponentType<SiteVisitorsNoteProps>;
  exhibit?: ComponentType<SiteVisitorsNoteProps & { state: SiteExhibitState }>;
}

/** The Visitors block's notes, after its count, in reorder-config order. */
export const SiteVisitors = {
  Note: defineRenderSlot<SiteVisitorsNote>({ docLabel: (p) => p.id }),
};
