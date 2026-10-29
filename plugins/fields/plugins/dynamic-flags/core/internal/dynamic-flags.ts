import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const checklistIcon = symbol("checklist");

/**
 * A free-key record of switches: option value → on/off. Only the keys the user
 * set are stored; an absent key means that option's own default, which the
 * option set (resolved at render time) carries. So the stored value never
 * enumerates the options, and an option added later needs no migration.
 */
export const dynamicFlagsFieldType =
  defineFieldType<Record<string, boolean>>("dynamic-flags");

// No `coerce`: a set of switches has no sortable scalar projection (like
// `object` and `json`).
export const dynamicFlagsIdentity = defineFieldIdentity<
  Record<string, boolean>
>({
  type: dynamicFlagsFieldType,
  kind: "label",
  label: "Dynamic Toggles",
  icon: checklistIcon,
});
