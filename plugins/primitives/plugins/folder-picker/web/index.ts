import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { FolderPicker, type FolderPickerProps } from "./internal/folder-picker";
export {
  FolderPickerPopover,
  type FolderPickerPopoverProps,
} from "./internal/folder-picker-popover";

export default {
  description:
    "Folder-picker primitive: browse the host filesystem and pick a directory. FolderPickerPopover pairs a typeable path input with a breadcrumb browser, both reading host-fs's live listing.",
  contributions: [],
} satisfies PluginDefinition;
