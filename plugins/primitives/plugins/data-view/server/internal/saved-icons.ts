import { getConfig, watchConfig } from "@plugins/config_v2/server";
import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import { defineSavedIconSource } from "@plugins/ui/plugins/icons/plugins/sprites/server";
import { dataViewDescriptors } from "./descriptors";

/** One view row as the descriptor parses it — only the key read here. */
interface ParsedViewRow {
  icon: SavedSymbolName | null;
}

/**
 * Every DataView view's picked switcher icon, so a switcher draws it at first
 * paint. Config lives on disk, not in Postgres, so the source watches every
 * surface's doc.
 */
export const viewIconsSource = defineSavedIconSource({
  id: "data-view.view-icons",
  tables: [],
  names: (): SavedSymbolName[] =>
    [...dataViewDescriptors.values()].flatMap((descriptor) =>
      (getConfig(descriptor).views as ParsedViewRow[]).flatMap((row) =>
        row.icon === null ? [] : [row.icon],
      ),
    ),
  watch: (onChange) => {
    const watchers = [...dataViewDescriptors.values()].map((descriptor) =>
      watchConfig(descriptor, onChange),
    );
    return () => {
      for (const watcher of watchers) watcher.dispose();
    };
  },
});
