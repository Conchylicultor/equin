import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { FolderPicker, type FolderPickerProps } from "./internal/folder-picker";
export {
  FolderPickerPopover,
  type FolderPickerPopoverProps,
} from "./internal/folder-picker-popover";

export default {
  description:
    "Folder-picker primitive: browse a file system's folders and pick one. FolderPicker / FolderPickerPopover take the file system (`fs`) the picked path is read on; the popover pairs a typeable path input with a breadcrumb browser, both reading that system's live folder listing (file-systems' useFolderListing).",
  contributions: [],
} satisfies PluginDefinition;
