import type { RoutedRecomputeOn } from "@plugins/network/plugins/live/plugins/resource-runtime/core";
import type { JoinFamily } from "@plugins/network/plugins/live/plugins/query-resource/core";
import type {
  compileJoins,
  ReadColumn,
} from "@plugins/network/plugins/live/plugins/query-resource/server";
import { ResourceContractError } from "@plugins/network/plugins/live/plugins/resource-protocol/core";
import type { Filterable } from "@plugins/network/plugins/live/plugins/filter/core";
import {
  scopedLiveColumns,
  type LiveColumnsDeclaration,
} from "@plugins/network/plugins/live/core";
import type { ScopedMemberRead, ServedScopedColumns } from "./serve-columns";

// A `scopedColumns` collection's per-QUERY scope, for both server halves
// (`serveCollection`, `serveUnionCollection`): a window tuple naming a scoped
// column carries the surface it is asked from (`scope`), and everything the
// scoped sets mean for that tuple is read off it here — the scope's gate
// (served by some set, else `contract-mismatch`), the column sets its codec
// decodes against (the scope's members AS THEY STAND), a member's read, and
// the per-tuple `recomputeOn` that reloads a tuple when its scope's members
// move. One family per set serves every scope (its scope column is matched per
// tuple), so a new scope costs no compile and no route.

type JoinPlan = ReturnType<typeof compileJoins>;

/** What a collection's compile reads of its scoped sets, per tuple scope. */
export interface ScopedTuples {
  /** One join family per set — handed to the compile (`families`). */
  readonly families: readonly JoinFamily[];
  /** The sets by name (a wire name's prefix). */
  readonly sets: ReadonlyMap<string, ServedScopedColumns>;
  /**
   * The scope a tuple's raw params name — gated: a scope no set serves is
   * refused (`ResourceContractError`); a served one is observed (its owner
   * watches its members from then on). `null` = the tuple names none.
   */
  scopeOf(params: { readonly scope?: string }): string | null;
  /**
   * The column sets a tuple of `scope` may name beside `base` (its own
   * handles): each set's members in that scope as they stand — rebuilt only
   * when a set's members moved, so the codec's per-array memo holds.
   */
  columnSets(
    base: readonly LiveColumnsDeclaration[],
    scope: string | null,
  ): readonly LiveColumnsDeclaration[];
  /**
   * A scoped wire name's read through `plan` (its family member, cast as its
   * type reads NOW), or `undefined` for a name of no scoped set. A member the
   * scope no longer has fails loudly (the scope's `recomputeOn` reloads its
   * readers, whose clients re-lower without it).
   */
  read(
    plan: JoinPlan,
    name: string,
    scope: string | null,
  ): { read: ReadColumn; sqlType: string } | undefined;
  /** A scoped wire name's filter column in `scope` (its domain), or `undefined`. */
  filterColumn(
    name: string,
    scope: string | null,
  ): Filterable[string] | undefined;
  /** Per tuple: the upstream tuple of the scope it names (none for a tuple naming none). */
  readonly recomputeOn: readonly RoutedRecomputeOn[];
}

export function scopedTuples(
  key: string,
  sets: readonly ServedScopedColumns[],
  fail: (message: string) => never,
): ScopedTuples {
  const byName = new Map<string, ServedScopedColumns>();
  for (const set of sets) {
    if (byName.has(set.name)) {
      fail(
        `two scoped column sets are named "${set.name}" — a set's name prefixes its wire names`,
      );
    }
    byName.set(set.name, set);
  }
  const reject = (message: string): never => {
    throw new ResourceContractError(
      key,
      `liveCollection("${key}"): ${message}`,
    );
  };
  const scopeOf = (params: { readonly scope?: string }): string | null => {
    const scope = params.scope;
    if (scope === undefined) return null;
    const serving = sets.filter((s) => s.serves(scope));
    if (serving.length === 0) {
      reject(
        `decode: \`scope\` "${scope}" is served by no scoped column set — not a surface whose columns this collection can read`,
      );
    }
    for (const set of serving) set.observe(scope);
    return scope;
  };
  // Per scope: the members' signature and the handles built from it.
  const declared = new Map<
    string,
    { key: string; handles: readonly LiveColumnsDeclaration[] }
  >();
  const scopedHandles = (scope: string): readonly LiveColumnsDeclaration[] => {
    const members = sets
      .filter((s) => s.serves(scope))
      .map((set) => [set, set.members(scope)] as const);
    const sig = JSON.stringify(
      members.map(([set, m]) => [
        set.name,
        [...m].map(([id, r]) => [id, r.domain]),
      ]),
    );
    const held = declared.get(scope);
    if (held !== undefined && held.key === sig) return held.handles;
    const handles = members.map(([set, m]) =>
      scopedLiveColumns(
        scope,
        set.name,
        Object.fromEntries(
          [...m].map(([id, r]) => [id, { domain: r.domain, sortable: true }]),
        ),
      ),
    );
    declared.set(scope, { key: sig, handles });
    return handles;
  };
  // The concatenation, memoized per (base, scope handles) so a codec's
  // per-array memo holds while nothing moved.
  const joined = new WeakMap<
    readonly LiveColumnsDeclaration[],
    WeakMap<
      readonly LiveColumnsDeclaration[],
      readonly LiveColumnsDeclaration[]
    >
  >();
  const columnSets = (
    base: readonly LiveColumnsDeclaration[],
    scope: string | null,
  ): readonly LiveColumnsDeclaration[] => {
    if (scope === null || sets.length === 0) return base;
    const scoped = scopedHandles(scope);
    let byScoped = joined.get(base);
    if (!byScoped) joined.set(base, (byScoped = new WeakMap()));
    let all = byScoped.get(scoped);
    if (!all) byScoped.set(scoped, (all = [...base, ...scoped]));
    return all;
  };
  const memberOf = (
    name: string,
    scope: string | null,
  ):
    | { set: ServedScopedColumns; member: string; read: ScopedMemberRead }
    | undefined => {
    if (scope === null) return undefined;
    const dot = name.indexOf(".");
    const set = dot < 0 ? undefined : byName.get(name.slice(0, dot));
    if (set === undefined) return undefined;
    const member = name.slice(dot + 1);
    const read =
      set.members(scope).get(member) ??
      fail(`"${name}" is not a member of scope "${scope}"`);
    return { set, member, read };
  };
  return {
    families: sets.map((s) => s.family),
    sets: byName,
    scopeOf,
    columnSets,
    read: (plan, name, scope) => {
      const m = memberOf(name, scope);
      if (m === undefined) return undefined;
      const cast = m.read.cast;
      return {
        read: plan.readMember(
          m.set.name,
          m.member,
          cast === undefined
            ? undefined
            : { cast: cast.sql, sqlType: cast.sqlType },
          scope!,
        ),
        sqlType: cast?.sqlType ?? "text",
      };
    },
    filterColumn: (name, scope) => {
      if (scope === null) return undefined;
      for (const h of scopedHandles(scope)) {
        const col = h.wireFilterable[name];
        if (col !== undefined) return col;
      }
      return undefined;
    },
    recomputeOn: sets.map((set): RoutedRecomputeOn => ({
      resource: set.recomputeOn.resource,
      paramsOf: (params) => {
        const scope = (params as { scope?: string }).scope;
        return scope === undefined || !set.serves(scope)
          ? null
          : set.recomputeOn.params(scope);
      },
    })),
  };
}
