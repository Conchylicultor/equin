import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  asUserPath,
  type UserPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

const folderIcon = symbol("folder");

export const directoryPathFieldType =
  defineFieldType<UserPath>("directory-path");

export const directoryPathIdentity = defineFieldIdentity<UserPath>({
  type: directoryPathFieldType,
  kind: "path",
  label: "Folder",
  icon: folderIcon,
  // A directory path is a string the user chose (`UserPath`: a backend
  // never reads it synchronously); coerce stays pure/total like text's.
  coerce: (v) => asUserPath(typeof v === "string" ? v : String(v ?? "")),
});
