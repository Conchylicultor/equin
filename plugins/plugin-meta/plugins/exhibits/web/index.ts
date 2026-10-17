import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { exhibitPane, exhibitsPane } from "./components/exhibits-pane";

export { useExhibits, useExhibit } from "./use-exhibits";
export type { ExhibitsResult, ExhibitResult } from "./use-exhibits";
export { ExhibitView } from "./components/exhibit-view";

export default {
  description:
    "Exhibit catalog: a plugin shows one of its REAL components standalone from an exhibits/ folder (isolatedExhibit / regionExhibit / appExhibit), collected into one generated registry. useExhibits() / useExhibit(id) answer loading / found / missing / ambiguous; <ExhibitView exhibit width?/> renders any arm inside its own error boundary. Debug → Exhibits lists the catalog as a DataView (searchable, grouped by id prefix, badged by runtime and geometry); a row opens the viewer pane (/debug/exhibits/x/<id>;theme=<app>) rendering that one exhibit at each of its widths inside an explicit, switchable theme boundary.",
  contributions: [
    Pane.Register({ pane: exhibitsPane }),
    Pane.Register({ pane: exhibitPane }),
    DebugApp.Sidebar({
      id: "exhibits",
      title: "Exhibits",
      icon: symbol("grid-view"),
      opens: { pane: exhibitsPane, params: {} },
    }),
  ],
  slots: { exhibits: exhibitsPane, exhibit: exhibitPane },
} satisfies PluginDefinition;
