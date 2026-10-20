import type { ReactElement } from "react";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { pluginTree } from "@plugins/plugin-meta/plugins/plugin-view/core";
import { pluginViewPane } from "@plugins/plugin-meta/plugins/plugin-view/web";
import { PluginTree } from "@plugins/apps/plugins/studio/plugins/explorer/web";
import { defineDataView } from "@plugins/primitives/plugins/data-view/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**, and
// must be declared HERE rather than reusing the Explorer's `studio.explorer.tree`
// — sharing that key would make filtering the Explorer silently filter this
// closure. Codegen attributes the marker to the defining plugin, which is what
// puts the views config under this plugin's own path.
const CLOSURE_TREE_VIEW = defineDataView("studio.compositions.closure-tree");

/**
 * The active composition's closure as a tinted plugin tree. The tint itself is
 * contributed by `explorer/membership` into the `Explorer.TreeRowAccent` slot
 * that `PluginTree` renders, painted off the same active-composition store this
 * pane seeds — so there is deliberately no tinting logic here.
 */
export function ClosureTreeSection(): ReactElement {
  const tree = useLive(pluginTree);
  const openPane = useOpenPane();
  const selected = pluginViewPane.useRouteEntry()?.params.pluginId ?? null;

  if (tree.status === "loading")
    return <Loading label="Loading plugin tree…" />;
  if (tree.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the plugin tree"
        error={tree.error}
        refetch={tree.refetch}
      />
    );
  }

  if (tree.status === "unavailable") {
    // Read from this checkout's `plugins/`, which an in-browser server lacks.
    return <Placeholder>{tree.message}</Placeholder>;
  }

  // Bounded: unbounded, the full tree dwarfs every sibling section.
  return (
    <Scroll axis="y" className="max-h-[60vh]">
      <PluginTree
        plugins={tree.data.plugins}
        storageKey={CLOSURE_TREE_VIEW}
        selected={selected}
        linkTo={(pluginId) =>
          openPane.to(
            pluginViewPane,
            { pluginId },
            { mode: "push", side: "right" },
          )
        }
      />
    </Scroll>
  );
}
