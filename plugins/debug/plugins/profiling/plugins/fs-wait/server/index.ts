import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { recordFsWaits } from "./internal/record-fs-waits";

export default {
  description:
    "recordFsWaits: a process root (the backend's bin, the CLI's bin) writes its slow file calls to its namespace's fs-wait log channel under one name per process.",
} satisfies ServerPluginDefinition;
