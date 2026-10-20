import { z } from "zod";
import {
  HOST_FS_MACHINE,
  HOST_FS_PEEK_MAX_NAMES,
  HostFsListingQuerySchema,
} from "@plugins/infra/plugins/host-fs/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import { ImageSizeSchema } from "./endpoints";

/** One resizable image of a folder and its upright pixel size. */
export const FolderImageSizeSchema = z.object({
  name: z.string(),
  size: ImageSizeSchema,
});
export type FolderImageSize = z.infer<typeof FolderImageSizeSchema>;

/**
 * The upright pixel size of every resizable image (`isResizableName`) in a
 * host folder, read from the headers only — `sizes` as a key-range-PAGED
 * value (a folder grows with the user's data), by name in code-point order,
 * over the same question as host-fs's `hostFsListing` (`{ path }`), so a
 * reader asks both of one folder alike. Only the images of the pages read are
 * measured. Pushed while read from a watch of the folder. Refused:
 * `invalid-path`, `missing`, `denied`, `not-a-dir`, `unreadable-archive`.
 */
export const hostFsFolderImageSizes = liveValue("host-fs.image-sizes", {
  query: HostFsListingQuerySchema,
  paged: {
    item: FolderImageSizeSchema,
    id: "name",
    key: { of: (image) => [image.name], order: ["asc"] },
    limit: 200,
    // As many as host-fs.list holds of one folder.
    maxLimit: HOST_FS_PEEK_MAX_NAMES,
  },
  refusals: [
    "invalid-path",
    "missing",
    "denied",
    "not-a-dir",
    "unreadable-archive",
  ],
  // The same feature as the host-fs.list it is read beside.
  needsMachine: HOST_FS_MACHINE,
});
