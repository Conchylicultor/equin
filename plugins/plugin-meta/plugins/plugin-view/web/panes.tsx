import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { studioApp } from "@plugins/apps/plugins/studio/plugins/shell/core";
import {
  PluginDetailForId,
  usePluginDisplayName,
} from "./components/plugin-detail-for-id";

export const pluginViewPane = Pane.define({
  route: defineRoute({
    id: "plugin-view",
    segment: "p/:pluginId",
  }),
  app: studioApp,
  component: PluginViewBody,
  width: 600,
  useResolve: false,
  title: { useText: usePluginViewTitle, fallback: "Plugin" },
});

/** The plugin's display name from the facets tree, or undefined while it loads. */
function usePluginViewTitle({
  pluginId,
}: {
  pluginId: string;
}): string | undefined {
  return usePluginDisplayName(pluginId);
}

function PluginViewBody() {
  const { pluginId } = pluginViewPane.useParams();
  return (
    <PaneChrome pane={pluginViewPane}>
      <PluginDetailForId pluginId={pluginId} />
    </PaneChrome>
  );
}
