import type { ReactElement } from "react";
import {
  pluginIdSegments,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  Breadcrumb,
  BreadcrumbPlaces,
  type BreadcrumbProps,
} from "@plugins/primitives/plugins/breadcrumb/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type { PluginNode } from "../../core";
import { pluginViewPane } from "../panes";

/**
 * One level of the plugin tree as a crumb's menu: the plugins of `level` (the
 * top-level plugins, or one plugin's children) in the tree's order, the one
 * on the trail first and marked, each with its own children as a submenu. The
 * whole tree is already in hand (the faceted tree the detail was read from),
 * so a level costs no read.
 */
function PluginLevel({
  level,
  trail,
}: {
  level: readonly PluginNode[];
  trail: ReadonlySet<string>;
}): ReactElement {
  const openPane = useOpenPane();
  return (
    <BreadcrumbPlaces
      places={level.map((plugin) => ({
        key: plugin.id,
        label: plugin.name,
        activation: openPane.to(
          pluginViewPane,
          { pluginId: plugin.id },
          { mode: "swap" },
        ),
        onTrail: trail.has(plugin.id),
        inside:
          plugin.children.length > 0 ? (
            <PluginLevel level={plugin.children} trail={trail} />
          ) : undefined,
      }))}
    />
  );
}

/**
 * A plugin's id as a trail: each ancestor a crumb that opens it, and resting
 * on any crumb lists the plugins beside it — its parent's children (the
 * top-level plugins for the first) — to jump across the tree.
 */
export function PluginTrail({
  id,
  plugins,
  actions,
}: {
  id: PluginId;
  /** The tree's top-level plugins — where every level is looked up. */
  plugins: readonly PluginNode[];
  actions?: BreadcrumbProps["actions"];
}): ReactElement {
  const openPane = useOpenPane();
  const parts = pluginIdSegments(id);
  const ids = parts.map((_, i) => parts.slice(0, i + 1).join("."));
  const trail = new Set(ids);
  // levels[i]: the plugins beside crumb i — the children of crumb i-1.
  const levels: (readonly PluginNode[] | undefined)[] = [];
  let level: readonly PluginNode[] | undefined = plugins;
  for (const crumbId of ids) {
    levels.push(level);
    level = level?.find((p) => p.id === crumbId)?.children;
  }
  return (
    <Breadcrumb
      segments={parts.map((name, i) => {
        const here = levels[i];
        return {
          key: ids[i]!,
          label: name,
          activation: openPane.to(
            pluginViewPane,
            { pluginId: ids[i]! },
            { mode: "swap" },
          ),
          // A crumb the tree does not hold (an id with no node) has no level.
          siblings:
            here === undefined ? null : (
              <PluginLevel level={here} trail={trail} />
            ),
        };
      })}
      actions={actions}
    />
  );
}
