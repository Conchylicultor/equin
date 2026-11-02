import type { ComponentType } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { PageMapLayerSpec } from "../core";

/**
 * A source of map overlays derived from a page's blocks.
 *
 * `overlays` is a PURE function of the page's blocks, so layers need no hooks
 * and compose trivially. An async layer (a road route from a server call) would
 * be a new component-shaped variant beside this, not a change to it.
 */
export type PageMapLayerContribution = PageMapLayerSpec;

/** What a map-block action is handed: the page whose map it sits on. */
export interface PageMapActionProps {
  pageId: string;
}

export const PageMap = {
  /**
   * Everything the `/map` block draws comes from here. The block runs every
   * layer and names none of them — which kind of block becomes a pin is the
   * layer's business.
   */
  Layer: defineSlot<PageMapLayerContribution>({
    docLabel: (l) => l.id,
  }),
  /**
   * Compact controls floated in the map's top-right corner, about the page
   * the map is on (open its places elsewhere, say). The block names none of
   * them, and draws nothing there when nothing is contributed. A contribution
   * should stay a small overlay button: it sits over the map's tiles.
   */
  Action: defineRenderSlot<{ component: ComponentType<PageMapActionProps> }>({
    docLabel: (a) => a.id,
  }),
};
