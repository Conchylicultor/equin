import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import { getPrototypeThumbnail } from "../core";
import { handleThumbnail } from "./internal/handlers";

export default {
  description:
    "Prototype thumbnails, desktop-only half: the immutable serving route (GET /api/prototype-thumbs/:key, needsMachine) for the PNGs in the on-disk cache.",
  httpRoutes: {
    [getPrototypeThumbnail.route]: machineHandler(
      getPrototypeThumbnail,
      handleThumbnail,
    ),
  },
} satisfies MachinePluginDefinition;
