import type { LoadedPlugin } from "@plugins/framework/plugins/web-sdk/core";
import { SlotRender } from "@plugins/primitives/plugins/slot-render/web";
import {
  markerAttrs,
  PluginMarkerMiddleware,
} from "../internal/marker-middleware";

/**
 * The picker's two slot-render contributions — the lineage stamp and the
 * portal-forwarding middleware — as the barrel contributes them, without the
 * rest of the barrel. A test renders it alongside the plugin under test.
 */
export const pickerPlugin = {
  id: "primitives.ui-context.element-picker",
  description: "element picker (lineage fixture)",
  contributions: [
    SlotRender.ItemAttrs({ attrs: markerAttrs }),
    SlotRender.ItemMiddleware({
      priority: 50,
      Component: PluginMarkerMiddleware,
    }),
  ],
  slots: SlotRender,
} as unknown as LoadedPlugin;
