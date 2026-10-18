import { useMemo } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-view/core";
import {
  DataView,
  defineDataView,
  type DataViewId,
  type FieldDef,
  type HierarchyConfig,
} from "@plugins/primitives/plugins/data-view/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Explorer } from "../slots";
import {
  flattenPluginTree,
  countDescendants,
  type ExplorerRow,
} from "../internal/flatten-plugin-tree";

const EXPLORER_VIEW = defineDataView("studio.explorer.tree");

const RUNTIME_KEYS = ["web", "server", "machine", "central"] as const;

// No expand hooks. Expand/collapse is per-(surface, view-instance, row) device-
// local render state owned by the data-view primitive, so this hierarchy closes
// over nothing and is a module constant.
const hierarchy: HierarchyConfig<ExplorerRow> = {
  getParentId: (r) => r.parentId,
  getRank: (r) => r.rank,
};

interface PluginTreeProps {
  plugins: PluginNode[];
  selected: string | null;
  /** Where a row goes: a link, so middle- / ⌘-click open it in a browser tab. */
  linkTo: (pluginId: string) => LinkTarget;
  /**
   * Which surface's view/filter/sort config this tree reads and writes. Defaults
   * to the Explorer pane's own. A second surface rendering this tree MUST pass
   * its own marker — sharing one would make filtering either tree filter both.
   */
  storageKey?: DataViewId;
}

export function PluginTree({
  plugins,
  selected,
  linkTo,
  storageKey = EXPLORER_VIEW,
}: PluginTreeProps) {
  const rows = useMemo(() => flattenPluginTree(plugins), [plugins]);

  // `name` is the primary (only-rendered-in-tree) field; the rest are
  // filter-only — invisible in the tree body but usable in the "Filter" pill.
  const fields = useMemo<FieldDef<ExplorerRow>[]>(
    () => [
      { id: "name", label: "Name", primary: true, value: (r) => r.name },
      { id: "path", label: "Path", type: "text", value: (r) => r.path },
      {
        id: "description",
        label: "Description",
        type: "text",
        value: (r) => r.description ?? "",
      },
      {
        id: "loadBearing",
        label: "Load-bearing",
        type: "bool",
        value: (r) => r.loadBearing,
      },
      {
        id: "collapsed",
        label: "Collapsed",
        type: "bool",
        value: (r) => r.collapsed,
      },
      {
        id: "childCount",
        label: "Children",
        type: "number",
        value: (r) => countDescendants(r),
      },
      {
        id: "runtimes",
        label: "Runtimes",
        type: "tags",
        values: (r) => RUNTIME_KEYS.filter((k) => r.runtimes[k]),
      },
    ],
    [],
  );

  // Every view is a table; the Tree view is the outline one, and its config
  // row (not this code) opens the whole tree on first paint and offers
  // expand-all (`defaultExpanded` / `expandAll`) — the grid Table views stay
  // collapsed. These code-only options draw on every view.
  const tableOptions = useMemo(
    () => ({
      // Both slots render a GROUP of contributions with no container of their
      // own — wrap each in a non-wrapping <Inline> so the accents / badges stay a
      // single-line cluster (the group-wrap axis, owned by container choice).
      rowAccent: (node: ExplorerRow) => (
        <Inline gap="2xs">
          <Explorer.TreeRowAccent.Render>
            {(item) => <item.component node={node} />}
          </Explorer.TreeRowAccent.Render>
        </Inline>
      ),
      trailing: (node: ExplorerRow) => (
        <Inline gap="2xs">
          <Explorer.TreeRowBadge.Render>
            {(item) => <item.component node={node} />}
          </Explorer.TreeRowBadge.Render>
        </Inline>
      ),
    }),
    [],
  );

  return (
    <DataView<ExplorerRow>
      rows={rows}
      fields={fields}
      rowKey={(r) => r.id}
      views={["table"]}
      defaultView="tree"
      storageKey={storageKey}
      hierarchy={hierarchy}
      selectedRowId={selected ?? undefined}
      rowActivation={(r) => linkTo(r.id)}
      searchAccessor={(r) => r.searchText}
      viewOptions={{ table: tableOptions }}
    />
  );
}
