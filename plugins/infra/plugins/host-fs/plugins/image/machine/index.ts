import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import { resizedImagesDir } from "../data-dirs";
import { hostFsImageResized } from "../core";
import { makeResizedHandler } from "./internal/resize";
import { hostFsFolderImageSizesServed } from "./internal/sizes";

export default {
  description:
    "Host images' desktop half: GET resized (a copy with a long edge from a closed set, EXIF-rotated, never enlarged — JPEG, or WebP with transparency — made with sharp, cached host-wide and served immutable for the file version the URL names; 415 when undecodable), and the host-fs.image-sizes live value — the upright pixel size of each resizable image in a folder, key-range-paged by name, only the read pages' headers measured, pushed from a watch of the folder while read.",
  httpRoutes: {
    [hostFsImageResized.route]: machineHandler(
      hostFsImageResized,
      makeResizedHandler(() => resizedImagesDir.path),
    ),
  },
  contributions: [...hostFsFolderImageSizesServed.declare],
} satisfies MachinePluginDefinition;
