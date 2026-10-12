import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import {
  PluginDetailForId,
  usePluginDisplayName,
} from "@plugins/plugin-meta/plugins/plugin-view/web";

export const pluginConvSidePane = Pane.define({
  route: defineRoute({
    id: "plugin-conv-side",
    segment: "plugin/:pluginId",
  }),
  app: agentManagerApp,
  component: PluginConvSideBody,
  width: 600,
  chrome: { history: false },
  useResolve: false,
  title: { useText: usePluginConvSideTitle, fallback: (p) => p.pluginId },
});

/** The plugin's display name from the facets tree, or undefined while it loads. */
function usePluginConvSideTitle({
  pluginId,
}: {
  pluginId: string;
}): string | undefined {
  return usePluginDisplayName(pluginId);
}

function PluginConvSideBody() {
  const { pluginId } = pluginConvSidePane.useParams();
  return (
    <PaneChrome pane={pluginConvSidePane}>
      <PluginDetailForId pluginId={pluginId} />
    </PaneChrome>
  );
}
