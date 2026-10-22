import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { activeDataBindingsServed } from "./internal/resource";
import { handleDeleteBinding, handlePutBinding } from "./internal/routes";
import { putBinding, deleteBinding } from "../core/endpoints";

export { _activeDataBindings } from "./internal/tables";

export default {
  portable: true,
  description:
    "Persistent state for inline interactive widgets — table + resource keyed by (conversationId, messageId, tag, occurrenceIndex).",
  contributions: [...activeDataBindingsServed.declare],
  httpRoutes: {
    [putBinding.route]: handlePutBinding,
    [deleteBinding.route]: handleDeleteBinding,
  },
} satisfies ServerPluginDefinition;
