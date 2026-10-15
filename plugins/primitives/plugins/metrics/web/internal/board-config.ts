import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type {
  Contribution,
  SealContributions,
} from "@plugins/framework/plugins/web-sdk/core";
import type {
  ViewSourceEntry,
  ViewTypeMeta,
} from "@plugins/primitives/plugins/data-view/plugins/view-core/core";
import {
  buildViewConfigContributions,
  buildViewDescriptors,
} from "@plugins/primitives/plugins/data-view/plugins/view-core/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

/**
 * A board's config: one view-core `views` document (`config/<plugin>/<id>.jsonc`)
 * whose rows are the board's tabs, each row's `view` a `BoardSpec` plus
 * `type: "board"`. Handed to `<Board config>`; its `contributions` go in the
 * declaring plugin's web barrel, next to the server twin
 * (`boardConfigRegistrations`) in its server barrel.
 */
export interface BoardConfig {
  id: string;
  /** The descriptor map `useViewModel` resolves `id` through (reference identity). */
  descriptors: Map<string, ConfigDescriptor>;
  /** The `ConfigV2.WebRegister` of this config, under the declaring plugin. */
  contributions: Contribution[];
}

/**
 * Declare a board config under `pluginId`. Call once, at module level, in the
 * plugin that owns the board: config_v2 matches a registration by descriptor
 * identity, so the handle `<Board>` reads must be the one the barrel registers.
 */
export function defineBoardConfig(id: string, pluginId: PluginId): BoardConfig {
  const { map, entries } = buildViewDescriptors([id]);
  return {
    id,
    descriptors: map,
    contributions: buildViewConfigContributions(
      entries.map((e) => ({ ...e, pluginId })),
    ),
  };
}

/** A board has one kind of view: a board. Its tabs are named instances of it. */
const BOARD_VIEW_TYPE: SealContributions<ViewTypeMeta> = {
  type: "board",
  title: "Board",
  icon: symbol("dashboard"),
};

/** The one source every board view binds to (stable: the model memoizes on it). */
export const BOARD_VIEW_ENTRIES: ViewSourceEntry[] = [
  { contributions: [BOARD_VIEW_TYPE] },
];
