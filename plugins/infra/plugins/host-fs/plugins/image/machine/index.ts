import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import { resizedImagesDir } from "../data-dirs";
import { computerImageResized } from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { makeResizedHandler } from "./internal/resize";
import { computerImageSizesServed } from "./internal/sizes";

export default {
  description:
    "Host images' desktop half: file-systems' GET /api/files/computer/image/resized (a copy with a long edge from a closed set, EXIF-rotated, never enlarged — JPEG, or WebP with transparency — made with sharp, cached host-wide and served immutable for the file version the URL names; 415 when undecodable), and file-systems' files.computer.image-sizes live value — the upright pixel size of each resizable image in a folder, key-range-paged by name, only the read pages' headers measured, pushed from a watch of the folder while read.",
  httpRoutes: {
    [computerImageResized.route]: machineHandler(
      computerImageResized,
      makeResizedHandler(() => resizedImagesDir.path),
    ),
  },
  contributions: [...computerImageSizesServed.declare],
} satisfies MachinePluginDefinition;
