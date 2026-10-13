// The join vocabulary of the routed compilers, as DATA
// (research/2026-09-29-global-scoped-change-routing.md, "Join vocabulary"). A
// bounded or grouping compile reads its base table plus the joins declared
// here, and emits from the SAME declaration the SQL it runs, the route each
// joined table's changes take to host ids, and the per-tuple read-set
// (`usesOf`) that says which of them a tuple reads and in which role.
//
// Type-only: `core/` is bundled into the browser, so nothing here may pull
// drizzle's runtime in. The server compiler (`server/internal/joins.ts`)
// renders and checks these specs.

import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

/** The relation the base table of a compile is named by in a `ColumnRef`. */
export const BASE_RELATION = "base";

/**
 * One column of one relation a compiled query reads: the base table
 * (`from: "base"`), or a declared join by its alias. `col` is the table's own
 * column object (`table.someColumn`); the compiler renders it against the
 * join's alias. Checked at module eval: `col` must belong to the relation `from`
 * names (A4). A column override returns a {@link TypedColumnRef} taken from its
 * `j` (`JoinRefs`), so a hand-written ref naming another table's column is a
 * tsc error there (T2).
 */
export interface ColumnRef {
  from: string;
  col: PgColumn;
}

/**
 * A `ColumnRef` that names its relation and column in its type: what
 * `j.<relation>.<column>` is. At runtime it is also a SQL fragment — the
 * column as the compile reads it (rendered against its relation, a defaulted
 * extension column as its COALESCE) — so an `ExprField` interpolates it
 * (`sql\`upper(${j.artist.name})\``; drizzle's `sql` takes any value, so the
 * type need not say so, and a hand-written ref stays a plain `ColumnRef`).
 */
export interface TypedColumnRef<
  R extends string,
  C extends PgColumn,
> extends ColumnRef {
  from: R;
  col: C;
}

/**
 * The columns a join exposes to row fields: its `wireColumns` when it carries
 * them (an extension handle's `join()` does — never a server-only column),
 * else every column of its table.
 */
interface JoinWire {
  /**
   * The columns row fields may bind to, by property name — an entity's wire
   * columns. Absent = every column of `table`.
   */
  wireColumns?: Readonly<Record<string, PgColumn>>;
}

/**
 * A 1:1 side table keyed by its host's id (`infra/entity-extensions`), joined
 * LEFT: a host with no side row still reads, with the side columns NULL (or
 * their defaults — see `absent`). `key` is the side table's host-key column
 * (its primary key), `parentKey` the column it references — by default the
 * base table's id, and the compiled resource's identity. Made by an extension
 * handle's `join(alias, opts?)`, never by hand.
 *
 * Its route is an `alias` on `key`: a side row I / U / D is a host U.
 *
 * With `on`, it is the extension of a RELATED entity instead (a conversation
 * list reading its task's `tasks_ext_track`): LEFT on `key = on`, `on` a
 * column of the base or of an EARLIER join naming the parent's id
 * (`attempt.taskId`). It routes as a non-required lookup does — `reverse` on
 * `key`, probed through `on`'s chain: a side row's write reaches the hosts
 * whose `on` names its parent.
 */
export interface ExtensionJoin<
  A extends string = string,
  T extends PgTable = PgTable,
> extends JoinWire {
  kind: "extension";
  alias: A;
  table: T;
  key: PgColumn;
  parentKey: PgColumn;
  /** The host-side column naming the parent (see above); absent = the base's identity. */
  on?: ColumnRef;
  /**
   * What a host with no side row reads per column (by property name): a
   * literal its read COALESCEs to — overriding the column's literal DB
   * default — or `null` (read NULL, no COALESCE). An exposing extension's
   * fields (`exposure.fields[f].absent`).
   */
  absent?: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * An N:1 lookup: `on` (a column of the base, or of an EARLIER join — lookups
 * chain) matches the looked-up table's `pk`. `required` makes it an INNER join,
 * so a host whose lookup row is missing is not a member; otherwise LEFT.
 *
 * Its route is a `reverse` on `pk`: a changed row is resolved, in the drain, to
 * the hosts whose `on` names it (`full` — "pre-image needed" — when the chain to
 * `on` passes through a join over the looked-up table itself, A10). Keyed by the
 * host's own id (`on` is the base identity), it is an `alias` like an extension.
 */
export interface LookupJoin<
  A extends string = string,
  T extends PgTable = PgTable,
> extends JoinWire {
  kind: "lookup";
  alias: A;
  table: T;
  pk: PgColumn;
  on: ColumnRef;
  required: boolean;
}

/**
 * A side table keyed by a composite key: the host's key in `hostKey`, plus
 * fixed `selectors` (e.g. `{ data_view_id: "<surface>", column_id: "c1" }`) —
 * together covering the side table's primary key, so the join is 1:1 (A4).
 * Joined LEFT on the host's identity.
 *
 * Its route is an `alias` on `hostKey` filtered by the selectors (`rows`): the
 * side table's routed trigger carries `hostKey` and every selector column in
 * its key layout, so a change reaches only the hosts it names, in the tuples
 * whose selectors match.
 */
export interface KeyedSideJoin<
  A extends string = string,
  T extends PgTable = PgTable,
> extends JoinWire {
  kind: "keyed-side";
  alias: A;
  table: T;
  selectors: ReadonlyArray<{ col: PgColumn; value: string }>;
  hostKey: PgColumn;
}

export type JoinSpec<A extends string = string, T extends PgTable = PgTable> =
  ExtensionJoin<A, T> | LookupJoin<A, T> | KeyedSideJoin<A, T>;

/**
 * A FAMILY of keyed-side joins over one composite-keyed side table: one join
 * per MEMBER a tuple reads (a DataView surface's custom columns — `member` is
 * `column_id`, each member's value its own column of the list), each the
 * keyed-side join `familyMember(family, m)`: `hostKey` + the fixed `selectors`
 * + `member = m`, together covering the side table's primary key.
 *
 * The set of members is open (config, not code), so a family is not a list of
 * joins but a generator: a tuple joins exactly the members its `where` / order
 * names, and ONE route serves the whole family — an `alias` on `hostKey`,
 * filtered by the selectors (`rows`) and, per tuple, by the members it reads
 * (`match` on `member`). A write to another member, or to another scope's rows,
 * reaches no tuple.
 */
export interface JoinFamily<T extends PgTable = PgTable> {
  kind: "family";
  /** The family's route id, and the prefix of its members' join aliases. */
  id: string;
  table: T;
  /** The side column carrying the host's key (compared as the host id's text). */
  hostKey: PgColumn;
  /** Fixed key columns, e.g. `data_view_id = "<surface>"`. */
  selectors: ReadonlyArray<{ col: PgColumn; value: string }>;
  /** The key column naming a member, e.g. `column_id`. */
  member: PgColumn;
  /** The column a member's value is read from. */
  value: PgColumn;
}

/** Postgres's identifier limit, in bytes: a longer alias is silently truncated. */
const IDENTIFIER_MAX_BYTES = 63;

/**
 * A member's join alias: the family id, then the member id with every
 * character outside `[A-Za-z0-9]` spelled `_<hex>_` — injective, so two members
 * can never share an alias (`cc-1` → `custom__cc_2d_1`).
 *
 * A spelling longer than Postgres's 63-byte identifier limit (a real id is
 * `cc-<uuid>`: 62 bytes under `custom`, so any longer family name or id format
 * would cross it) becomes `<family>___h<hash>`, a 128-bit hash of the member
 * id. The two forms cannot meet — a spelled member starts with `[A-Za-z0-9]`
 * or `_<hex>`, never `_h` — and every alias stays inside the limit whatever
 * the member ids look like; the compile that renders members fails loudly on
 * two members sharing one.
 */
export function familyMemberAlias(familyId: string, member: string): string {
  let out = "";
  for (const ch of member) {
    out += /[A-Za-z0-9]/.test(ch) ? ch : `_${ch.codePointAt(0)!.toString(16)}_`;
  }
  const spelled = `${familyId}__${out}`;
  return spelled.length <= IDENTIFIER_MAX_BYTES
    ? spelled
    : `${familyId}___h${fnv1a128(member)}`;
}

// FNV-1a over the UTF-8 bytes, 128 bits, base 36 (at most 25 characters).
// Browser-safe (no node:crypto: this file is in core).
const FNV_OFFSET = 0x6c62272e07bb014262b821756295c58dn;
const FNV_PRIME = 0x0000000001000000000000000000013bn;
const MASK_128 = (1n << 128n) - 1n;
function fnv1a128(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_128;
  }
  return hash.toString(36);
}

/** One member of a family, as the keyed-side join it is. */
export function familyMember<T extends PgTable>(
  family: JoinFamily<T>,
  member: string,
): KeyedSideJoin<string, T> {
  return {
    kind: "keyed-side",
    alias: familyMemberAlias(family.id, member),
    table: family.table,
    selectors: [...family.selectors, { col: family.member, value: member }],
    hostKey: family.hostKey,
  };
}

/** The columns a join exposes to row fields (see `JoinWire`), by property name. */
export type JoinWireColumns<S extends JoinSpec> = S extends {
  wireColumns: infer W extends Readonly<Record<string, PgColumn>>;
}
  ? W
  : S["table"]["_"]["columns"];

/** The `TypedColumnRef` of every column of `Cols`, as relation `R`, by property name. */
export type ColumnRefsOf<
  R extends string,
  Cols extends Readonly<Record<string, PgColumn>>,
> = {
  readonly [K in keyof Cols & string]: TypedColumnRef<R, Cols[K]>;
};

/**
 * The argument of a column override `(j) => ColumnRef`: `j.base` names the base
 * source's wire columns (`BaseCols`: an entity's `wireColumns`, or a table's
 * columns), `j.<alias>` each declared join's (`JoinWireColumns`). A relation
 * that is not declared cannot be spelled, nor can a server-only column (T2).
 */
export type JoinRefs<
  BaseCols extends Readonly<Record<string, PgColumn>>,
  J extends readonly JoinSpec[],
> = {
  readonly base: ColumnRefsOf<typeof BASE_RELATION, BaseCols>;
} & {
  readonly [S in J[number] as S["alias"]]: ColumnRefsOf<
    S["alias"],
    JoinWireColumns<S>
  >;
};

/**
 * What a column override may return: one of the refs its `j` offers — so a
 * hand-written `{ from: "base", col: otherTable.x }` does not compile (T2).
 */
export type JoinRef<Refs> = {
  [R in keyof Refs]: Refs[R][keyof Refs[R]];
}[keyof Refs];

/**
 * The columns a static predicate over the joins is written with:
 * `j.base.title`, `j.<alias>.plays` — each rendered against its relation, so
 * `sql\`${j.playback.plays} > 0\`` reads the join, not its table.
 */
export type JoinColumns<Base extends PgTable, J extends readonly JoinSpec[]> = {
  readonly base: Base["_"]["columns"];
} & {
  readonly [S in J[number] as S["alias"]]: S["table"]["_"]["columns"];
};
