import { useMemo } from "react";
import { pluginIdSegments } from "@plugins/framework/plugins/plugin-id/core";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  CollapsibleChevron,
  FoldMotion,
  useCollapsible,
} from "@plugins/primitives/plugins/collapsible/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  useGraph,
  useEnsureCompositionData,
} from "@plugins/plugin-meta/plugins/composition/web";
import {
  SectionCount,
  type PluginNode,
  pluginViewPane,
} from "@plugins/plugin-meta/plugins/plugin-view/web";
import {
  buildDepTree,
  type DepDirection,
  type DepTreeNode,
} from "../internal/build-dep-tree";

const EMPTY: Record<DepDirection, string> = {
  deps: "No dependencies.",
  dependents: "Nothing depends on this.",
};

/** The dependency tree in one direction, or `null` while the graph loads. */
function useDepTree(node: PluginNode, direction: DepDirection) {
  useEnsureCompositionData();
  const graph = useGraph();
  return useMemo(
    () => (graph ? buildDepTree(graph, node.id, direction) : null),
    [graph, node.id, direction],
  );
}

export function DependsOnSection({ node }: { node: PluginNode }) {
  return <DependencySection node={node} direction="deps" />;
}

export function UsedBySection({ node }: { node: PluginNode }) {
  return <DependencySection node={node} direction="dependents" />;
}

/**
 * An empty tree in this direction ⇒ nothing to list. Declared as each
 * contribution's `useAvailable` rather than the body's "No dependencies." /
 * "Nothing depends on this." placeholder: the host paints the card before it
 * reaches the body, so the placeholder is a titled bar the user opens onto
 * nothing. While the graph loads the section stays painted (the body shows its
 * own Loading), so a leaf plugin's cards do not pop in and out on every visit.
 */
function useHasDeps(node: PluginNode, direction: DepDirection): boolean {
  const tree = useDepTree(node, direction);
  return tree === null || tree.total > 0;
}

export function useHasDependsOn({ node }: { node: PluginNode }): boolean {
  return useHasDeps(node, "deps");
}

export function useHasUsedBy({ node }: { node: PluginNode }): boolean {
  return useHasDeps(node, "dependents");
}

export function DependsOnCount({ node }: { node: PluginNode }) {
  return <DependencyCount node={node} direction="deps" />;
}

export function UsedByCount({ node }: { node: PluginNode }) {
  return <DependencyCount node={node} direction="dependents" />;
}

/** The tree size, readable while the card is collapsed. Silent until loaded. */
function DependencyCount({
  node,
  direction,
}: {
  node: PluginNode;
  direction: DepDirection;
}) {
  const tree = useDepTree(node, direction);
  if (!tree || tree.total === 0) return null;
  return <SectionCount>{tree.total}</SectionCount>;
}

function DependencySection({
  node,
  direction,
}: {
  node: PluginNode;
  direction: DepDirection;
}) {
  const tree = useDepTree(node, direction);

  if (!tree) return <Loading />;

  if (tree.total === 0) {
    return <Text tone="muted">{EMPTY[direction]}</Text>;
  }

  return (
    // eslint-disable-next-line spacing/no-adhoc-spacing -- -mx-2 negative-bleeds the tree rows out to cancel the section card's horizontal padding so row hover backgrounds span full width
    <Stack direction="col" gap="none" className="-mx-2">
      {tree.roots.map((root, i) => (
        <DepRow key={`${root.id}-${i}`} node={root} depth={0} />
      ))}
    </Stack>
  );
}

function DepRow({ node, depth }: { node: DepTreeNode; depth: number }) {
  const {
    open: expanded,
    toggle,
    triggerProps,
    contentProps,
  } = useCollapsible();
  const openPane = useOpenPane();
  const hasChildren = node.children.length > 0 && !node.duplicate;
  const segs = pluginIdSegments(node.id);
  const label = segs[segs.length - 1] ?? String(node.id);

  const chevronIcon = hasChildren ? (
    <button
      {...triggerProps}
      className="rounded-sm text-muted-foreground hover:text-foreground"
      // The row under it opens the plugin: the toggle must not reach it.
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
    >
      <Center className="size-4">
        <CollapsibleChevron open={expanded} className="size-3.5" />
      </Center>
    </button>
  ) : (
    <span className="block size-4" />
  );

  return (
    <>
      <Row
        size="sm"
        indent={depth * 16 + 8}
        icon={chevronIcon}
        {...openPane.link(
          pluginViewPane,
          { pluginId: node.id },
          { mode: "swap" },
        )}
        className="min-h-7"
        title={String(node.id)}
      >
        <Text>{label}</Text>
        {node.kind === "soft" && <Badge variant="info">soft</Badge>}
        {node.duplicate && (
          <Text tone="muted" title="already shown above">
            ↑
          </Text>
        )}
      </Row>
      {hasChildren && (
        <FoldMotion {...contentProps}>
          {node.children.map((c, i) => (
            <DepRow key={`${c.id}-${i}`} node={c} depth={depth + 1} />
          ))}
        </FoldMotion>
      )}
    </>
  );
}
