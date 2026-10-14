import type { SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { RoutedRecomputeOn } from "@plugins/framework/plugins/resource-runtime/core";
import type {
  ColumnRef,
  ExtensionJoin,
  JoinFamily,
} from "@plugins/infra/plugins/query-resource/core";
import type { EntityExposure } from "@plugins/infra/plugins/entity-extensions/core";
import type { FilterDomainId } from "@plugins/network/plugins/live/plugins/filter/core";

// ── Scoped column sets ─────────────────────────────────────────────────────
// A collection declared with a `columnScope` sorts and filters by columns whose
// set is data, not code — a DataView surface's custom columns. Their values
// live in one composite-keyed side table (scope, host key, member, value); the
// members a scope has are read at request time. `serveCollection` joins that
// table once per member a tuple names (a join FAMILY — one route for all of
// them, matched per tuple on the member), and recomputes every tuple when the
// scope's members change (`recomputeOn`, an external value the contributor
// notifies). The browser half is `scopedLiveColumns` (core).

/** One member of a scoped set as the server reads it now. */
export interface ScopedMemberRead {
  /** The filter domain its (cast) value reads in. */
  domain: FilterDomainId;
  /**
   * How the stored value reads as its type — a cast of the raw column and the
   * SQL type it produces (the type a page cut's operand casts back to);
   * absent = the raw column, as text.
   */
  cast?: { sql: (raw: PgColumn) => SQL; sqlType: string };
}

/** A scoped column set, served: its side table and the members each scope has. */
export interface ServedScopedColumns {
  /** Unique; the prefix of every wire name (`<name>.<member>`) and the family's route id. */
  readonly name: string;
  /**
   * A collection's fold: binds the set to the collection's scope — recorded
   * in `scopes()` — and returns that scope's family. Every `columnScope`
   * collection folding the set calls it (it cannot join a member without the
   * family), so the recorded scopes are exactly the ones served.
   */
  bind(scope: string): JoinFamily;
  /**
   * Every scope a collection has bound the set under — what the set's owner
   * watches to notify `recomputeOn(scope)`. Complete once deferred resources
   * are bound (before the ready barrier).
   */
  scopes(): ReadonlySet<string>;
  /** The members a scope has now, by id. */
  members(scope: string): ReadonlyMap<string, ScopedMemberRead>;
  /**
   * The external value tuple whose change means `members(scope)` changed: every
   * subscribed tuple of a collection in that scope recomputes FULL (a member's
   * cast, or its existence, moved under the compiled SQL).
   */
  recomputeOn(scope: string): RoutedRecomputeOn;
}

/**
 * Serve a scoped column set: one composite-keyed side table — `scope` (e.g.
 * `data_view_id`), `hostKey` (the host row's key, `row_key`), `member`
 * (`column_id`) and `value` — whose members per scope `members` answers.
 * Spread into a `LiveColumns.Scoped(...)` contribution.
 */
export function serveScopedColumns<P extends Record<string, string>>(spec: {
  name: string;
  table: PgTable;
  scope: PgColumn;
  hostKey: PgColumn;
  member: PgColumn;
  value: PgColumn;
  members: (scope: string) => ReadonlyMap<string, ScopedMemberRead>;
  recomputeOn: (scope: string) => RoutedRecomputeOn<P>;
}): ServedScopedColumns {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(spec.name)) {
    throw new Error(
      `serveScopedColumns("${spec.name}"): a set's name is a plain identifier (it prefixes wire names and join aliases)`,
    );
  }
  const families = new Map<string, JoinFamily>();
  // One family object per scope: a compile renders members through it, and
  // the plan that applies a tuple's joins finds them by it.
  const family = (scope: string): JoinFamily => {
    let out = families.get(scope);
    if (!out) {
      out = {
        kind: "family",
        id: spec.name,
        table: spec.table,
        hostKey: spec.hostKey,
        selectors: [{ col: spec.scope, value: scope }],
        member: spec.member,
        value: spec.value,
      };
      families.set(scope, out);
    }
    return out;
  };
  const bound = new Set<string>();
  return {
    name: spec.name,
    bind: (scope) => {
      bound.add(scope);
      return family(scope);
    },
    scopes: () => bound,
    members: spec.members,
    recomputeOn: spec.recomputeOn,
  };
}

// ── Exposed fields ─────────────────────────────────────────────────────────
// An entity extension declaring `exposes` (entity-extensions) is served by
// handing its handle to `LiveColumns.Expose`: every collection whose `exposes`
// reaches the exposure's parent entity — directly (`base`) or through a lookup
// join — folds it in at boot, joining the extension LEFT (keyed on the base's
// id, or on the lookup's `on` column) under the exposure's slice. Neither the
// extension nor the collection names the other.

/**
 * What `LiveColumns.Expose` takes: an entity extension handle that exposes
 * fields (`defineExtension` over a shape declaring `exposes` — one exposing
 * none is a tsc error) — its exposure, and the join that reads it.
 */
export interface ExposingExtension {
  readonly exposure: EntityExposure;
  join(alias: string, opts?: { on: ColumnRef }): ExtensionJoin;
}

export const LiveColumns = {
  /**
   * A scoped column set (`serveScopedColumns`): every collection declaring a
   * `columnScope` sorts and filters by its members in that scope. Collected at
   * boot; each such collection's `serveCollection` folds every contribution.
   */
  Scoped: defineServerContribution<ServedScopedColumns>("live.columns.scoped", {
    docLabel: (s) => s.name,
  }),
  /**
   * An entity extension's exposed fields (`LiveColumns.Expose(ext)`): every
   * collection whose `exposes` reaches the exposure's parent entity folds them
   * into its rows. Collected at boot. An exposure no collection reaches is
   * not an error — an entity may have no list yet.
   */
  Expose: defineServerContribution<ExposingExtension>("live.columns.expose", {
    docLabel: (e) => `${e.exposure.parent.name} ← ${e.exposure.slice}`,
  }),
};
