import type { ReactElement } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { pluginFacetsTree } from "../../core";
import type { PluginNode } from "../../core";
import { PluginDetail } from "./plugin-detail";

function findNode(nodes: PluginNode[], id: string): PluginNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The plugin's display name from the faceted tree (its id when no node answers
 * to it), or undefined while the tree loads or after it failed — the shape a
 * pane's `title.useText` takes.
 */
export function usePluginDisplayName(pluginId: string): string | undefined {
  const tree = useLive(pluginFacetsTree);
  if (tree.status === "loading" || tree.status === "error") return undefined;
  return findNode(tree.data.plugins, pluginId)?.name ?? pluginId;
}

/**
 * The one reader of a plugin's detail by id: the faceted tree's read rendered
 * as loading, failed (with Retry) or the {@link PluginDetail} of the matching
 * node. Every pane that shows a plugin by id hosts this inside its own chrome.
 */
export function PluginDetailForId({
  pluginId,
}: {
  pluginId: string;
}): ReactElement {
  const tree = useLive(pluginFacetsTree);
  switch (tree.status) {
    case "loading":
      return (
        <Center axis="both" className="h-full">
          <Loading />
        </Center>
      );
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="the plugin tree"
          error={tree.error}
          refetch={tree.refetch}
        />
      );
    case "ready":
      return (
        <PluginDetail node={findNode(tree.data.plugins, pluginId) ?? null} />
      );
  }
}
