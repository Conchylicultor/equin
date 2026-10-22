import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
// Registers the configured icons' saved-icon source (module eval).
import "./internal/saved-icons";
import { ConfigV2 } from "@plugins/config_v2/server";
import { conversationCategoriesServed } from "./internal/resource";
import { handleClearCategory } from "./internal/routes";
import { clearConversationCategory } from "../shared/endpoints";
import { conversationCategoryConfig } from "../shared/config";

export { conversationCategoryConfig } from "../shared/config";
// The generic category API. Consumers (stats) enumerate a category's items
// through it and never name one, so adding or removing a category needs no edit
// there. `itemOrder` is pure over the config value — the config read is the
// caller's (desktop) business, so this half stays portable.
export { itemOrder } from "./internal/item-order";
export type { CategoriesConfigValue } from "./internal/item-order";
export { getItemMap } from "./internal/store";
// The table `getItemMap` reads, for a live value that declares its reads.
export { conversationCategoriesEntity } from "./internal/tables";

export default {
  description:
    "The conversation-category assignments, portable half: the categories config, the configured avatars' saved-icon source, the table, the lookup-only conversation-categories collection over it, the cross-plugin per-category item read, and clearing one assignment. The Haiku classifier and setting an item are the machine/ half's.",
  contributions: [
    ConfigV2.Register({ descriptor: conversationCategoryConfig }),
    ...conversationCategoriesServed.declare,
  ],
  httpRoutes: {
    [clearConversationCategory.route]: handleClearCategory,
  },
  portable: true,
} satisfies ServerPluginDefinition;
