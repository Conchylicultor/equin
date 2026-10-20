import {
  readDataViewConfigDoc,
  watchDataViewConfigDoc,
} from "@plugins/primitives/plugins/data-view/server";
import { resolveFieldValueTextCast } from "@plugins/fields/plugins/server-capabilities/server";
import {
  LiveColumns,
  serveScopedColumns,
  serveValue,
  type ScopedMemberRead,
} from "@plugins/network/plugins/live/server";
import {
  CUSTOM_COLUMNS_SET,
  customColumnDefs,
  type CustomColumnDef,
} from "../../core";
import { readCustomColumnDefs } from "../../shared/read-custom-column-defs";
import { _dataViewCustomValues } from "@plugins/primitives/plugins/data-view/plugins/custom-columns/plugins/values/server";

// Custom columns on a LIVE collection (research/2026-09-29-global-scoped-change-routing.md
// P3): the `custom` scoped column set. A collection declaring a `columnScope`
// (its DataView surface) sorts and filters by that surface's custom columns
// under their wire names `custom.<column id>`; each tuple joins
// `data_view_custom_values` once per column it names (a join FAMILY, one route
// for them all: an alias on `row_key`, kept to the surface's rows and matched
// per tuple on the columns it reads). The definitions are config, so the
// members are read at request time, and every live tuple on the surface
// recomputes when they change (`customColumnDefs`, notified from a config
// watch).

/** A surface's definitions, as its config says now. */
function defsOf(dataViewId: string): CustomColumnDef[] {
  return readCustomColumnDefs(readDataViewConfigDoc(dataViewId).customColumns);
}

/** How a definition's TEXT-stored value reads: its type's cast, and the domain and SQL type it produces. */
function readOf(def: CustomColumnDef): ScopedMemberRead {
  const read = resolveFieldValueTextCast(def.type);
  return read.cast === undefined
    ? { domain: read.domain }
    : {
        domain: read.domain,
        cast: { sql: read.cast, sqlType: read.sqlType },
      };
}

/** Served from the config; notified by `watchScopedDefinitions` when a watched surface's definitions change. */
export const customColumnDefsServed = serveValue(customColumnDefs, {
  source: "external",
  changes: "notified",
  loader: ({ dataViewId }) => defsOf(dataViewId),
});

/** The `custom` scoped set: `data_view_custom_values`, keyed by surface, row and column. */
export const customScopedColumns = serveScopedColumns({
  name: CUSTOM_COLUMNS_SET,
  table: _dataViewCustomValues,
  scope: _dataViewCustomValues.dataViewId,
  hostKey: _dataViewCustomValues.rowKey,
  member: _dataViewCustomValues.columnId,
  value: _dataViewCustomValues.value,
  members: (scope) =>
    new Map(defsOf(scope).map((def) => [def.id, readOf(def)])),
  recomputeOn: (scope) => ({
    resource: customColumnDefsServed,
    params: { dataViewId: scope },
  }),
});

/** The self-registering contribution wired into the plugin's `contributions`. */
export const customColumnsScoped = LiveColumns.Scoped(customScopedColumns);

/**
 * Watch every surface a live collection is scoped to — the scopes the set was
 * bound under (`scopes()`, recorded by each collection's fold, so a collection
 * serving the set cannot go unwatched) — and notify its definitions when they
 * change (a config write that moved only the view state compares equal and
 * notifies nothing). Called from `onReady`, after the config registry is up and
 * every scoped collection has bound.
 */
export function watchScopedDefinitions(): void {
  for (const scope of customScopedColumns.scopes()) {
    let last = JSON.stringify(defsOf(scope));
    watchDataViewConfigDoc(scope, (doc) => {
      const next = JSON.stringify(readCustomColumnDefs(doc.customColumns));
      if (next === last) return;
      last = next;
      customColumnDefsServed.notify({ dataViewId: scope });
    });
  }
}
