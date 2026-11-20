import { webLists } from "@plugins/framework/plugins/list-catalog/plugins/web-lists/core";

/** One reorderable web list: what reorder registers a config directive for. */
export interface ReorderableSlot {
  slotId: string;
  /** The plugin that DECLARES the list — where its config file lives. */
  pluginId: string;
  /** The list's declaration key: its config file's basename. */
  configName: string;
}

/**
 * Every reorderable web list the main composition declares — a VIEW of the
 * list catalog's declared web lists
 * (`list-catalog/web-lists`, written by the build from what each plugin
 * declares, `meta.reorderable` as the slot stamped it). The server cannot see
 * web slots; the web runtime derives the same set from the slot objects.
 */
export const reorderableSlots: readonly ReorderableSlot[] = webLists
  .filter((l) => l.meta.reorderable && l.inMain)
  .map((l) => ({ slotId: l.id, pluginId: l.plugin, configName: l.key }));
