import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-view/web";
import { pluginFacetsTree } from "@plugins/plugin-meta/plugins/plugin-view/core";
import { FileBrowser } from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { filePeekPane } from "@plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web";

// Sentinel resolving to the current running server's own worktree root.
const SELF_WORKTREE = "self";

export function FileTreeSection({ node }: { node: PluginNode }) {
  // The pane that renders this section already holds the tree, so this is a
  // cache hit: it carries the absolute `plugins/` folder the node paths are
  // relative to — this checkout's.
  const tree = useLive(pluginFacetsTree);
  const openPane = useOpenPane();

  if (tree.status === "loading") return <Loading variant="rows" />;
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
  const { pluginsRoot } = tree.data;
  const pluginDir = `${pluginsRoot}/${node.path}`;

  return (
    <Clip className="h-96 rounded-md border">
      <FileBrowser
        key={pluginDir}
        initialPath={pluginDir}
        root={pluginDir}
        onOpenFile={(path) =>
          openPane(
            filePeekPane,
            {
              worktree: SELF_WORKTREE,
              // Repo-relative: `plugins/` plus the path under it.
              filePath: `plugins/${path.slice(pluginsRoot.length + 1)}`,
            },
            { mode: "push" },
          )
        }
      />
    </Clip>
  );
}
