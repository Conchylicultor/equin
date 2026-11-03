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
// A collection declared `scopedColumns` sorts and filters by columns whose set
// is data, not code — the custom columns of the DataView surface a query is
// asked from (the query's `scope`). Their values live in one composite-keyed
// side table (scope, host key, member, value); the members a scope has are
// read at request time. `serveCollection` joins that table once per member a
// tuple names, in the scope the tuple names (a join FAMILY with a scope
// column — one route for every member of every scope, matched per tuple on
// both), and recomputes a tuple when its scope's members change
// (`recomputeOn`, an external value the contributor notifies). The browser
// half is `scopedLiveColumns` (core).

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
   * The set's join family: a member is `(scope, member)`, the scope the
   * tuple's — one family (and so one route) per collection, whatever scopes
   * its tuples name.
   */
  readonly family: JoinFamily;
  /**
   * Whether a query may name `scope` — the set's own vocabulary of scopes (a
   * custom column's: a DataView surface the app declares). A tuple naming any
   * other is refused (`contract-mismatch`) before anything is read.
   */
  serves(scope: string): boolean;
  /**
   * A tuple names `scope`: the first time, the set's owner starts watching
   * what moves its members (its `watch`), so `recomputeOn(scope)` is notified
   * from then on. Idempotent; called by every collection's params gate.
   */
  observe(scope: string): void;
  /** The members a scope has now, by id. */
  members(scope: string): ReadonlyMap<string, ScopedMemberRead>;
  /**
   * The external value whose tuple `params(scope)` changing means
   * `members(scope)` changed: every tracked tuple naming that scope recomputes
   * FULL (a member's cast, or its existence, moved under the compiled SQL).
   */
  readonly recomputeOn: ScopedRecomputeOn;
}

/** A scoped set's members' upstream: an external value, one tuple per scope. */
export interface ScopedRecomputeOn<
  P extends Record<string, string> = Record<string, string>,
> {
  resource: RoutedRecomputeOn<P>["resource"];
  params: (scope: string) => P;
}

/**
 * Serve a scoped column set: one composite-keyed side table — `scope` (e.g.
 * `data_view_id`), `hostKey` (the host row's key, `row_key`), `member`
 * (`column_id`) and `value` — whose scopes `serves` names and whose members
 * per scope `members` answers. `watch(scope)` starts what notifies
 * `recomputeOn(scope)` (called once per scope, the first time a tuple names
 * it). Spread into a `LiveColumns.Scoped(...)` contribution.
 */
export function serveScopedColumns<P extends Record<string, string>>(spec: {
  name: string;
  table: PgTable;
  scope: PgColumn;
  hostKey: PgColumn;
  member: PgColumn;
  value: PgColumn;
  serves: (scope: string) => boolean;
  members: (scope: string) => ReadonlyMap<string, ScopedMemberRead>;
  recomputeOn: ScopedRecomputeOn<P>;
  watch: (scope: string) => void;
}): ServedScopedColumns {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(spec.name)) {
    throw new Error(
      `serveScopedColumns("${spec.name}"): a set's name is a plain identifier (it prefixes wire names and join aliases)`,
    );
  }
  const family: JoinFamily = {
    kind: "family",
    id: spec.name,
    table: spec.table,
    hostKey: spec.hostKey,
    selectors: [],
    scope: spec.scope,
    member: spec.member,
    value: spec.value,
  };
  const observed = new Set<string>();
  return {
    name: spec.name,
    family,
    serves: spec.serves,
    observe: (scope) => {
      if (observed.has(scope)) return;
      observed.add(scope);
      spec.watch(scope);
    },
    members: spec.members,
    recomputeOn: spec.recomputeOn as unknown as ScopedRecomputeOn,
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
   * A scoped column set (`serveScopedColumns`): every collection declaring
   * `scopedColumns` sorts and filters by its members, in the scope a query
   * names. Collected at boot; each such collection's `serveCollection` /
   * `serveUnionCollection` folds every contribution.
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
