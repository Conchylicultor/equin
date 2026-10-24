import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import { getMirroredFile, getMirroredNestedFile } from "../core";
import { handleMirror } from "./internal/handle-mirror";

export default {
  description:
    "The asset mirror's route, desktop-only (needsMachine): GET /api/asset-mirror/:id/:file and /:id/:dir/:file serve a registered mirror's file from the on-disk cache, downloading it from the remote source on a miss.",
  httpRoutes: {
    [getMirroredFile.route]: machineHandler(getMirroredFile, handleMirror),
    [getMirroredNestedFile.route]: machineHandler(
      getMirroredNestedFile,
      handleMirror,
    ),
  },
} satisfies MachinePluginDefinition;
