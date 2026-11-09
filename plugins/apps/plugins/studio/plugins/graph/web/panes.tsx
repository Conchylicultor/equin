import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { studioApp } from "@plugins/apps/plugins/studio/plugins/shell/core";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { GraphView } from "./components/graph-view";

export const graphCanvasPane = Pane.define({
  title: "Plugin Graph",
  // `:focusId?` — which plugin to center the closure subgraph on. A VIEW of the
  // graph, so it has an address (a link to "the graph around X" opens there in a
  // new browser tab too), while the bare `graph` stays valid: no focus seeds from
  // the active composition, else the search prompt.
  route: defineRoute({ id: "graph", segment: "graph/:focusId?" }),
  app: studioApp,
  component: GraphBody,
  // A focus id that names no plugin is not a missing pane: the graph view
  // renders nothing around it and the search prompt picks another.
  useResolve: false,
});

function GraphBody() {
  const { focusId } = graphCanvasPane.useParams();
  return (
    <PaneChrome pane={graphCanvasPane}>
      <Clip className="h-full">
        <GraphView paneFocusId={focusId as PluginId | undefined} />
      </Clip>
    </PaneChrome>
  );
}
