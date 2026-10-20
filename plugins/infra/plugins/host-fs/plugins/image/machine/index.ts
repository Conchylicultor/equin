import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { hostFsFolderImageSizesServed } from "./internal/sizes";

export default {
  description:
    "Host images' desktop half: the host-fs.image-sizes live value — the upright pixel size of each resizable image in a folder, key-range-paged by name, only the read pages' headers measured, pushed from a watch of the folder while read.",
  contributions: [...hostFsFolderImageSizesServed.declare],
} satisfies MachinePluginDefinition;
