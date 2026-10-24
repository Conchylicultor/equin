import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { enumFieldType } from "@plugins/fields/plugins/enum/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const labelIcon = symbol("label");

/**
 * The `tag` field type — ONE value out of an option forest: `field.options`
 * whose entries carry `parent` (a tag tree's tags, flattened in tree order with
 * their colour as `swatch`). It knows nothing about where the forest comes
 * from; any forest-shaped option set qualifies.
 *
 * It `extends` enum, so its cell (a chip), filter (pick values) and inline
 * editor are enum's, which all read `field.options`. What differs is grouping:
 * its own (`plugins/data-view-group`) nests the sections along the forest.
 */
export const tagFieldType = defineFieldType<string>("tag");

export const tagIdentity = defineFieldIdentity<string>({
  type: tagFieldType,
  label: "Tag",
  icon: labelIcon,
  extends: enumFieldType,
});
