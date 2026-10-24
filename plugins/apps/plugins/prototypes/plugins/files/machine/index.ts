import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import {
  getPrototypeEntry,
  getPrototypeFile,
  getPrototypeVersionFile,
} from "../core";
import { handlePrototypeAsset, handlePrototypeFile } from "./internal/files";
import { handlePrototypeVersionFile } from "./internal/version-file";

export default {
  description:
    "Prototype files, desktop-only half (needsMachine): serves the raw files of the on-disk prototypes tree — GET /api/prototypes/:name (a 302 to its index.html), /:name/:file (no-store, picks stamped onto the document) and /:name/versions/:sha/:file (a recorded version's file, immutable).",
  httpRoutes: {
    [getPrototypeEntry.route]: machineHandler(
      getPrototypeEntry,
      handlePrototypeFile,
    ),
    [getPrototypeFile.route]: machineHandler(
      getPrototypeFile,
      handlePrototypeAsset,
    ),
    [getPrototypeVersionFile.route]: machineHandler(
      getPrototypeVersionFile,
      handlePrototypeVersionFile,
    ),
  },
} satisfies MachinePluginDefinition;
