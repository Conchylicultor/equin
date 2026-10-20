import { getConfig, watchConfig } from "@plugins/config_v2/server";
import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import { defineSavedIconSource } from "@plugins/ui/plugins/icons/plugins/saved-sources/server";
import { prepromptsConfig } from "../../shared/config";

/**
 * Every configured preprompt's icon, so it draws at first paint. Config lives on disk, not in Postgres,
 * so the source watches it.
 */
export const savedIconsSource = defineSavedIconSource({
  id: "preprompts.icons",
  tables: [],
  names: (): SavedSymbolName[] =>
    getConfig(prepromptsConfig).preprompts.flatMap((p) =>
      p.icon.icon === null ? [] : [p.icon.icon],
    ),
  watch: (onChange) => {
    const watcher = watchConfig(prepromptsConfig, onChange);
    return () => watcher.dispose();
  },
});
