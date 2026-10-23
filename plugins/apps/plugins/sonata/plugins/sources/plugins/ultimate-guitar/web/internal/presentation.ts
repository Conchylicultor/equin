import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { ultimateGuitarShape } from "../../core";

/**
 * The Key field of every list of songs — the Ultimate Guitar tab's key, from
 * the UG exposure (`ultimateGuitarShape`): a card token, a table column, a
 * sort key and a filter dimension at once. A song with no UG tab (or a tab
 * with no key) reads null and the cell renders nothing.
 */
export const ugKeyPresentation = FieldPresentation.Register({
  owner: ultimateGuitarShape.exposure,
  fields: {
    key: { icon: symbol("key"), width: "4rem" },
  },
});
