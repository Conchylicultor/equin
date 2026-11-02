import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Editor } from "@plugins/page/plugins/editor/web";
import { mapBlock } from "../core";
import { PageMap } from "./slots";
import { MapBlock } from "./components/map-block";

export { PageMap } from "./slots";
export type { PageMapActionProps, PageMapLayerContribution } from "./slots";

export default {
  description:
    "Map block type: draws every located item on the page on an interactive map (through the map primitive), with overlays derived on each render from the page's blocks by contributed PageMap.Layer functions — so the map cannot drift from the page and names no block type. Clicking a pin scrolls to and selects the block it stands for; items a layer cannot place yet are counted under the map. Contributed PageMap.Action controls float in the map's top-right corner, handed the page id.",
  contributions: [
    Editor.Block({
      id: mapBlock.type,
      match: mapBlock.type,
      block: mapBlock,
      component: MapBlock,
      caret: "editor",
    }),
  ],
  slots: PageMap,
} satisfies PluginDefinition;
