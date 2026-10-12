import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";

export interface PluginNode {
  /** Path relative to plugins/, e.g. "active-data/plugins/conv". */
  path: string;
  /** Last-segment leaf name, e.g. "conv". */
  name: string;
  /** Dotted plugin id, e.g. "active-data.conv". */
  id: PluginId;
  description?: string;
  loadBearing: boolean;
  collapsed: boolean;
  runtimes: { web: boolean; server: boolean; central: boolean };
  children: PluginNode[];
  /**
   * Per-facet extracted data, keyed by facet id (e.g. "exports", "routes").
   * The sole metadata surface: every consumer reads `node.facets[facetId]` via an
   * id carried by its own contribution (DiffRenderer/PluginView.Section/Contributions.FacetTable),
   * never a hardcoded literal. The facets-tree value always populates it.
   */
  facets: Record<string, unknown>;
}

export interface PluginTreePayload {
  /**
   * The absolute `plugins/` folder this tree was read from (this checkout's) —
   * what every node's `path` is relative to.
   */
  pluginsRoot: string;
  plugins: PluginNode[];
  totals: {
    plugins: number;
    loadBearing: number;
    umbrellas: number;
  };
}
