import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const folderIcon = symbol("folder");

export const directoryPathFieldType = defineFieldType<string>("directory-path");

export const directoryPathIdentity = defineFieldIdentity<string>({
  type: directoryPathFieldType,
  kind: "path",
  label: "Folder",
  icon: folderIcon,
  // A directory path is just a string; coerce stays pure/total like text's.
  coerce: (v) => (typeof v === "string" ? v : String(v ?? "")),
});
