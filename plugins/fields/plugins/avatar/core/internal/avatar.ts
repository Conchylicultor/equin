import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol, type SavedSymbolName } from "@plugins/ui/plugins/icons/core";

const faceIcon = symbol("face");

/**
 * A stored avatar: a Material Symbols name the user picked (drawn by `<Icon>`
 * as a runtime symbol, in the surrounding theme's icon style) and a colour key.
 * Both null = no avatar chosen.
 */
export interface AvatarSpec {
  icon: SavedSymbolName | null;
  color: string | null;
}

export const avatarFieldType = defineFieldType<AvatarSpec>("avatar");

export const avatarIdentity = defineFieldIdentity<AvatarSpec>({
  type: avatarFieldType,
  kind: "visual",
  label: "Avatar",
  icon: faceIcon,
  coerce: (v) => v?.icon ?? "",
});
