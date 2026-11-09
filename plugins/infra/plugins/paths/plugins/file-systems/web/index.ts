import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  fileTextUnavailableMessage,
  useFileText,
} from "./internal/use-file-text";
export type {
  FileTextState,
  FileTextUnavailable,
} from "./internal/use-file-text";
export {
  fileBytesUnavailableMessage,
  useFileBytes,
} from "./internal/use-file-bytes";
export type {
  FileBytesState,
  FileBytesUnavailable,
} from "./internal/use-file-bytes";
export { useFileStat } from "./internal/use-file-stat";
export type { FileStatState } from "./internal/use-file-stat";

export default {
  description:
    "One read of a file in any file system: useFileText, useFileBytes and useFileStat take a FileLocation and read that system's live value (the computer's disk, the browser's storage, a checkout), so a reader never branches on where a file lives; a system this host cannot run is `unavailable`, nothing read.",
  contributions: [],
} satisfies PluginDefinition;
