import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { fsWaitRegistration } from "./internal/registration";

export { recordFsWaits } from "./internal/record-fs-waits";

export default {
  description:
    "Records a backend's and an exec child's slow file calls to their namespace's fs-wait log channel from the register phase on; recordFsWaits does the same for a CLI run.",
  register: [fsWaitRegistration],
} satisfies ServerPluginDefinition;
