import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { folderPlaces, FolderPlaces } from "./internal/folder-places";
export type { FolderPlacesOptions } from "./internal/folder-places";

export default {
  description:
    "A file system's folders (and, with { files: true }, its files after them, each row with its file-type icon) as a path crumb's menu: folderPlaces(fs, { files }) is the PathPlaces a path bar source or a FilepathBreadcrumb hands its crumbs — each level the folders inside one folder (hidden ones only when on the trail), read with useFolderListing when its menu opens, sorted as people sort, the one on the trail first and marked, each folder's own folders a submenu read when it opens; the loading and failure states drawn in the menu, and a bounded window with More for a very large folder.",
  contributions: [],
} satisfies PluginDefinition;
