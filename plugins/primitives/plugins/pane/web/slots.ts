import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { AnyPane } from "./pane";

// Exported as `Pane` so docgen renders the slot label as `Pane.Register`,
// matching the convention used by Shell.Sidebar, Code.ToolbarButton, etc.
// Imported and re-exposed on the runtime `Pane` namespace in pane.ts.
export const Pane = {
  // Page-wide: a pane is a definition, not content, and `useSyncPaneRegistry`
  // refills the ONE page registry from this list — at the apps root and again
  // inside an embedded app's `PluginScope`, which must not narrow it.
  Register: defineSlot<{ pane: AnyPane }>({
    pageWide: true,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- pane may be undefined at docgen time
    docLabel: (p) => p.pane?.id,
  }),
};
