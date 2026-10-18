import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { AvatarCell } from "./components/avatar-cell";

export {
  AvatarCellDataError,
  avatarFieldDef,
  type AvatarFieldDefOptions,
} from "./components/avatar-cell";

export default {
  description:
    "Avatar field type: data-view table cell (icon + color disc) plus the avatarFieldDef authoring helper.",
  contributions: [
    DataViewSlots.Cell({
      match: "avatar",
      companion: true,
      component: AvatarCell,
      chip: true,
    }),
  ],
} satisfies PluginDefinition;
