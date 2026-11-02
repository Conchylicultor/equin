import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { rowKind } from "@plugins/network/plugins/live/core";

/**
 * A page's place as a list row (`PageOverlayItem`): joined in the browser
 * from the page's blocks and your places, so no database data — a row kind.
 * Its number is the page order; the list searches by name. The row carries
 * the rest of the item (address, position, the saved place), which no list
 * shows as a field.
 */
export const pageOverlayItemKind = rowKind("places.page-overlay.item", {
  fields: {
    name: textField({ label: "Name", primary: true }),
    n: intField({ label: "Number on the page" }),
  },
  carry: { fields: { blockId: textField() } },
  id: "blockId",
});
