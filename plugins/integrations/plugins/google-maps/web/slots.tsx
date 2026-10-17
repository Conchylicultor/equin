import { useEffect } from "react";
import { defineDispatchSlot } from "@plugins/primitives/plugins/slot-render/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

/** How Google drew a map: a Map ID only gives the vector map when it is a vector JavaScript Map ID. */
export type MapRendering = "vector" | "raster";

/** What a preview map settled on. `error` is a map that could not be drawn at all (script load failure, key refused). */
export type MapIdPreviewResult =
  { kind: MapRendering } | { kind: "error"; message: string };

export interface MapIdPreviewProps {
  browserKey: string;
  mapId: string;
  /**
   * Called once per mounted preview, when Google has said how it drew the map
   * (or that it could not). A new map instance — a different Map ID, or the
   * "Check again" remount — reports again.
   */
  onResult: (result: MapIdPreviewResult) => void;
}

/**
 * Slots of the Live map setup pane.
 *
 * `MapIdPreview` is a slot, not an import, because the preview is a Google map
 * and Google map creation belongs to `map/google` — which already imports this
 * plugin (browser config, setup affordances), so importing it back would be a
 * cycle. The pane asks "draw a map with this key and Map ID and tell me how
 * Google rendered it"; the renderer plugin answers. With no contribution
 * installed the pane says so loudly instead of showing an empty box.
 */
export const LiveMapSetup = {
  /**
   * A dispatch slot with one constant key rather than a list: the pane renders
   * THE preview (`.Dispatch`, error-isolated), and an uncontributed slot falls
   * through to a loud message.
   */
  MapIdPreview: defineDispatchSlot<MapIdPreviewProps, "preview">({
    key: () => "preview",
    fallback: NoPreviewRenderer,
  }),
};

/** Shown while no plugin contributes a preview map: a visible state, never a blank box. */
function NoPreviewRenderer({ onResult }: MapIdPreviewProps) {
  useEffect(() => {
    onResult({ kind: "error", message: "no map renderer is installed" });
    // Once per mount: the pane remounts the preview for every new check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Text as="p" variant="caption" tone="destructive">
      No map renderer is installed, so the Map ID cannot be checked.
    </Text>
  );
}
