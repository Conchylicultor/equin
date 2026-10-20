import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { conversationCategoriesServed } from "./internal/resource";
import { handleClearCategory } from "./internal/routes";
import { clearConversationCategory } from "../shared/endpoints";

export { conversationCategoryConfig } from "../shared/config";
// The generic category API. Consumers (stats) enumerate a category's items
// through it and never name one, so adding or removing a category needs no edit
// there. `itemOrder` is pure over the config value — the config read is the
// caller's (desktop) business, so this half stays portable.
export { itemOrder } from "./internal/item-order";
export type { CategoriesConfigValue } from "./internal/item-order";
export { getItemMap } from "./internal/store";

export default {
  description:
    "The conversation-category assignments, portable half: the table, the lookup-only conversation-categories collection over it, the cross-plugin per-category item read, and clearing one assignment. The config, the Haiku classifier and setting an item are the machine/ half's.",
  contributions: [...conversationCategoriesServed.declare],
  httpRoutes: {
    [clearConversationCategory.route]: handleClearCategory,
  },
  portable: true,
} satisfies ServerPluginDefinition;
