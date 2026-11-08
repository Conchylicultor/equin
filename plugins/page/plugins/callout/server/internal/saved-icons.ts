import { isNull } from "drizzle-orm";
import { serveCollection } from "@plugins/network/plugins/live/server";
import { _blocks } from "@plugins/page/plugins/editor/server";
import { defineSavedIconSource } from "@plugins/ui/plugins/icons/plugins/saved-sources/server";
import { blocksByType, calloutBlock, calloutDataSchema } from "../../core";

// Only the icon: a payload the sprites cannot draw from is one whose icon is bad.
const calloutIconSchema = calloutDataSchema.pick({ icon: true });

// Routed over the `page_blocks` TABLE with the live-block predicate as its
// base membership (a routed compile reads a base table, never the
// `liveBlocks` subquery): a trash is a where-flip exit, a restore an entrant.
export const blocksByTypeServed = serveCollection(blocksByType, {
  from: _blocks,
  where: isNull(_blocks.deletedAt),
});

/**
 * Every live callout's saved icon, so callouts are drawable at first paint.
 * Followed, not read whole: a write to any other block — the page editor's
 * typing projection, an agent note — reaches the sprites not at all.
 */
export const calloutIconsSource = defineSavedIconSource({
  code: import.meta,
  kind: "followed",
  id: "page.callout-icons",
  collection: blocksByTypeServed,
  where: { type: calloutBlock.type },
  namesOf: (rows) =>
    rows.flatMap((row) => {
      const icon = calloutIconSchema.parse(row.data).icon;
      return icon === null ? [] : [icon];
    }),
});
