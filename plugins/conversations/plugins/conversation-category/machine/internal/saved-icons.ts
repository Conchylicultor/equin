import { getConfig, watchConfig } from "@plugins/config_v2/server";
import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import { defineSavedIconSource } from "@plugins/ui/plugins/icons/plugins/saved-sources/server";
import { conversationCategoryConfig } from "../../shared/config";

/**
 * Every category item's configured avatar icon, so it draws at first paint. Config lives on disk, not in Postgres,
 * so the source watches it.
 */
export const savedIconsSource = defineSavedIconSource({
  id: "conversation-category.avatars",
  tables: [],
  names: (): SavedSymbolName[] =>
    getConfig(conversationCategoryConfig).categories.flatMap((c) =>
      c.items.flatMap((item) =>
        item.avatar.icon === null ? [] : [item.avatar.icon],
      ),
    ),
  watch: (onChange) => {
    const watcher = watchConfig(conversationCategoryConfig, onChange);
    return () => watcher.dispose();
  },
});
