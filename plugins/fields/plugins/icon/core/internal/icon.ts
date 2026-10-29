import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol, type SavedSymbolName } from "@plugins/ui/plugins/icons/core";

const imageIcon = symbol("image");

/**
 * A stored icon: a Material Symbols name the user picked (drawn by `<Icon>` as
 * a runtime symbol, in the surrounding theme's icon style), or null when none
 * is chosen — the owner then draws its own default.
 */
export const iconFieldType = defineFieldType<SavedSymbolName | null>("icon");

export const iconIdentity = defineFieldIdentity<SavedSymbolName | null>({
  type: iconFieldType,
  kind: "visual",
  label: "Icon",
  icon: imageIcon,
  coerce: (v) => v ?? "",
});
