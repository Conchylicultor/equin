import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { ColumnDef } from "@plugins/primitives/plugins/data-table/web";
import type { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-view/core";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";

/** One plugin's slice of a facet's data, paired with its node. */
export interface FacetTableEntry<T = unknown> {
  node: PluginNode;
  data: T;
}

/**
 * Caller-aware pane opener handed to interactive rows. It is the host's
 * `useOpenPane()` result, so a `rowActivation` can `push` a detail pane relative
 * to the Contributions pane (`openPane.to(…)`) — which a module-scope opener
 * cannot do.
 */
export type ContributionsRowActivationContext = {
  openPane: ReturnType<typeof useOpenPane>;
};

/**
 * Declarative aggregated cross-plugin table for one facet. Contributed to the
 * `Contributions.FacetTable` slot. The Contributions host slices `node.facets[facetId]` for
 * every plugin, builds entries, projects them to rows, and renders through the
 * data-table primitive — staying entirely facet-blind.
 */
export interface ContributionsFacetTable<Row = unknown> {
  /** Facet id; host slices `node.facets[facetId]` for every plugin. */
  facetId: string;
  /** Tab label, e.g. "Routes", "Slots". */
  label: string;
  /** Tab icon for the Contributions category strip. */
  icon: IconRef;
  /** Columns passed straight to the data-table primitive. */
  columns: ColumnDef<Row>[];
  /** Project the per-plugin facet entries into flat table rows. */
  rows: (entries: FacetTableEntry[]) => Row[];
  /** Stable, unique key per row (passed to data-table's `rowKey`). */
  rowKey: (row: Row) => string;
}

/**
 * Type-erasing factory. `columns`/`rows`/`rowKey` correlate over `Row`, but the
 * slot stores one homogeneous `ContributionsFacetTable` (= `<unknown>`). Because `Row`
 * sits in contravariant positions, a concrete `ContributionsFacetTable<RouteRow>` is NOT
 * assignable to `ContributionsFacetTable<unknown>`. This factory type-checks authoring
 * against the concrete `Row`, then erases for storage in the slot.
 */
export function defineFacetTable<Row>(
  table: ContributionsFacetTable<Row>,
): ContributionsFacetTable {
  return table as ContributionsFacetTable;
}

/** A keyed row drill-down contributed by the owner of the target pane
 *  (app-side), so a facet renderer (meta) never imports an app pane. */
export interface ContributionsRowActivation<Row = unknown> {
  /** Facet id whose table rows this makes clickable. */
  facetId: string;
  /**
   * What activating the projected row does, given the host's `useOpenPane()`
   * opener — a `LinkTarget` (`openPane.to(…)`), so ⌘/middle-click opens the
   * drill-down in a new browser tab.
   */
  rowActivation: (
    row: Row,
    ctx: ContributionsRowActivationContext,
  ) => Activation;
}

export function defineRowActivation<Row>(
  entry: ContributionsRowActivation<Row>,
): ContributionsRowActivation {
  return entry as ContributionsRowActivation;
}
