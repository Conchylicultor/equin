import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { pluginViewPane } from "@plugins/plugin-meta/plugins/plugin-view/web";
import { pluginTree } from "@plugins/plugin-meta/plugins/plugin-view/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { PluginTree } from "./plugin-tree";

export function ExplorerView() {
  const tree = useLive(pluginTree);

  const openPane = useOpenPane();
  const selectedId = pluginViewPane.useRouteEntry()?.params.pluginId ?? null;

  if (tree.status === "loading") {
    return (
      <Center axis="both" className="h-full">
        <Loading label="Loading plugin tree…" />
      </Center>
    );
  }
  if (tree.status === "error") {
    return (
      <Center axis="both" className="h-full p-2xl">
        <ResourceErrorInline
          variant="block"
          subject="the plugin tree"
          error={tree.error}
          refetch={tree.refetch}
        />
      </Center>
    );
  }

  const { plugins, totals } = tree.data;

  // PaneChrome owns the single scroll. The stats band scrolls with the content
  // (not sticky) so it doesn't collide with the tree's own sticky DataView
  // toolbar, which pins to the top once the stats scroll past.
  return (
    <>
      <div className="border-b px-lg py-md">
        <Stack gap="xs">
          <Stat value={totals.plugins} label="plugins" />
          <Stat value={totals.loadBearing} label="load-bearing" />
          <Stat value={totals.umbrellas} label="umbrellas" />
        </Stack>
      </div>
      <PluginTree
        plugins={plugins}
        selected={selectedId}
        linkTo={(id) =>
          openPane.to(pluginViewPane, { pluginId: id }, { mode: "push" })
        }
      />
    </>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <Text variant="caption" as="div">
      <span className="font-medium text-foreground">{value}</span>{" "}
      <span className="text-muted-foreground">{label}</span>
    </Text>
  );
}
