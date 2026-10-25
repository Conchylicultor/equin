import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { deploymentSiteMessagesServed } from "./internal/served";

export default {
  description:
    "Reads a deployment's stored site messages over SSH through host-query's hostOnlyQueryOverSsh (the intake's host-only list, newest first) and answers a discriminated result: the page, or which of SSH, the request or the answer failed.",
  contributions: [...deploymentSiteMessagesServed.declare],
} satisfies ServerPluginDefinition;
