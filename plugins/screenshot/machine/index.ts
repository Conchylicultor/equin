import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { saveScreenshotFile } from "../shared/endpoints";
import { handleSaveFile } from "./internal/handle-save-file";

export default {
  description:
    "Screenshots, desktop-only half: writes a screenshot to a file on the computer's disk (POST /api/screenshots/:id/file, needsMachine) so a launched agent can read it by path.",
  httpRoutes: {
    [saveScreenshotFile.route]: handleSaveFile,
  },
} satisfies MachinePluginDefinition;
