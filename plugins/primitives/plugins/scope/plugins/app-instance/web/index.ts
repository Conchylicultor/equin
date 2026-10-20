import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export type { NavigationType } from "./internal/app-instance";
export {
  appInstanceId,
  getAppInstanceId,
  getNavigationType,
  readAppInstance,
  stampAppInstance,
} from "./internal/app-instance";

export default {
  description:
    "Per-app-instance generation id: which running SPA state a document belongs to, and the instance-scoped id that storage entries are keyed by.",
  contributions: [],
} satisfies PluginDefinition;
