import type {
  FilterColumn,
  Filterable,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { KIND_RE } from "@plugins/infra/plugins/query-resource/core";
import type {
  LiveArmsCollection,
  LiveCollection,
  LiveRowSchema,
} from "./live-collection";
import { mintColumnRef, type LiveColumnRef } from "./column-ref";
import type { LiveFilterable } from "./query";

// Contributed columns: a collection declared `contributed: true` can be
// sorted and filtered by columns OTHER plugins own (Sonata's library by a
// song's play count, which playback-history owns). The set is open, so the
// collection names none of them: each contributor declares a HANDLE here, in
// its own core (browser-safe, nothing registered), and serves it from its own
// server (`serveColumns` + `LiveColumns.Serve`). A query over contributed
// columns hands the codec the handles it reads, so encoding validates against
// them — there is no registry to be empty before a plugin tier loads.

/** The reserved row field a contributed collection's rows carry the contributed values under. */
export const LIVE_COLUMNS_KEY = "$columns";

/**
 * The reserved WINDOW-only field a scoped collection's rows carry the scoped
 * columns their tuple ORDERS BY under (by the server's join alias) — so the
 * order signature sees a member's value move. Not a row field: every read hands
 * rows out without it, like `$key`.
 */
export const LIVE_SCOPED_KEY = "$scoped";

/**
 * A row's contributed values: contributor name → its fields. Opaque to
 * everyone but the handles, which parse their own slice (`handle.read(row)`).
 */
export type ContributedColumns = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

/** A contributed collection's row: the author's row, plus its contributed values. */
export type WithContributedColumns<Row> = Row & {
  readonly $columns: ContributedColumns;
};

/**
 * Who a column set belongs to — and so which collection may read it. Every
 * reader switches on it exhaustively (T11): a fourth kind of set is a tsc
 * error at each site that must decide what it means there.
 *
 * - `contributed` — another plugin's columns on a `contributed: true`
 *   collection (`liveColumns`), served by `serveColumns`;
 * - `scoped` — a data-defined set (`scopedLiveColumns`), read by whichever
 *   collection declares `scope` as its `columnScope`;
 * - `arm` — one arm's own columns on an `arms` (union) collection
 *   (`liveArmColumns`), present only on that arm's rows;
 * - `exposed` — an entity extension's exposed fields (`exposedColumns`), read
 *   by every collection whose `exposes` reaches `entity`.
 */
export type LiveColumnsOwner =
  | { readonly kind: "contributed"; readonly collection: string }
  | { readonly kind: "scoped"; readonly scope: string }
  | {
      readonly kind: "arm";
      readonly collection: string;
      readonly arm: string;
    }
  | { readonly kind: "exposed"; readonly entity: string };

/**
 * What every reader of a column set needs of it — the codec (which wire names
 * it may validate), the server compile (which fields to bind and fold), a
 * column ref — with its row type erased. A typed {@link LiveColumnsHandle} /
 * {@link LiveArmColumnsHandle} is one.
 */
export interface LiveColumnsDeclaration {
  readonly kind: "live-columns";
  /** Who the set belongs to (see {@link LiveColumnsOwner}). */
  readonly owner: LiveColumnsOwner;
  /**
   * Unique per collection — the `$columns` key, and every wire name's prefix
   * (an arm's set is named by its arm).
   */
  readonly name: string;
  /** Every field the contributor projects (its row schema's keys). */
  readonly fields: readonly string[];
  /** Its row schema's fields, by name — each field's own schema. */
  readonly rowShape: Readonly<Record<string, unknown>>;
  /** A field's wire name: `<name>.<field>`. */
  wireName(field: string): string;
  /** The filter declaration by WIRE name — what a codec extends its own with. */
  readonly wireFilterable: Filterable;
  /** The sortable wire names. */
  readonly wireSortable: readonly string[];
}

/**
 * One contributor's columns on a contributed collection: their row schema, and
 * which of them filter (in which domain) and sort. Wire names are
 * `<name>.<field>`.
 */
export interface LiveColumnsHandle<
  CRow,
  F,
  S extends string,
> extends LiveColumnsDeclaration {
  readonly owner: { readonly kind: "contributed"; readonly collection: string };
  /** The contributor's fields, parsed by `read`. */
  readonly row: LiveRowSchema<CRow>;
  readonly fields: readonly (keyof CRow & string)[];
  /** Field → filter domain (by FIELD name). */
  readonly filterable: F;
  readonly sortable: readonly S[];
  /** A column ref a list binds a field to (`FieldDef.column`), carrying this handle. */
  column(field: NoInfer<(keyof F & string) | S>): LiveColumnRef;
  /** This contributor's slice of a row, parsed with its row schema (once per row object). */
  read(row: { readonly $columns: ContributedColumns }): CRow;
}

/** A collection a contributor may declare columns on. */
export type LiveContributedCollection<
  Row,
  F,
  S extends string,
> = LiveCollection<WithContributedColumns<Row>, F, S> & { contributed: true };

/**
 * Declare one contributor's columns on a `contributed: true` collection (a
 * collection without it is a tsc error, and throws). Browser-safe and
 * registers nothing: the handle is the declaration, and the contributor's
 * server serves it (`serveColumns(handle, { join })` in a `LiveColumns.Serve`
 * contribution).
 */
export function liveColumns<
  Row,
  F0,
  S0 extends string,
  CRow,
  const F extends LiveFilterable<CRow>,
  const S extends keyof CRow & string = never,
>(
  collection: LiveContributedCollection<Row, F0, S0>,
  name: string,
  spec: {
    row: LiveRowSchema<CRow>;
    filterable: F;
    sortable: readonly S[];
  },
): LiveColumnsHandle<CRow, F, S> {
  const fail = (message: string): never => {
    throw new Error(`liveColumns("${collection.key}", "${name}"): ${message}`);
  };
  if ((collection as { contributed?: boolean }).contributed !== true) {
    fail("the collection is not declared `contributed: true`");
  }
  if (!KIND_RE.test(name)) {
    fail("a contributor name is a plain identifier (no `.`)");
  }
  const owner = { kind: "contributed", collection: collection.key } as const;
  const parts = typedColumns(owner, name, spec, fail, () => handle);
  const parsed = new WeakMap<object, CRow>();
  const handle: LiveColumnsHandle<CRow, F, S> = {
    ...parts,
    owner,
    read: (row) => {
      const cached = parsed.get(row);
      if (cached !== undefined) return cached;
      const slice = row.$columns[name];
      if (slice === undefined) {
        return fail(
          "the row carries no values for this contributor — is its server half (`serveColumns` in a `LiveColumns.Serve` contribution) mounted?",
        );
      }
      const value = spec.row.parse(slice);
      parsed.set(row, value);
      return value;
    },
  };
  return handle;
}

/**
 * What a typed column set (contributed or arm) shares: its declaration, its
 * row schema and filter / sort vocabulary, and the refs a list binds to.
 */
export type TypedColumnsParts<CRow, F, S extends string> = Omit<
  LiveColumnsDeclaration,
  "owner"
> & {
  readonly row: LiveRowSchema<CRow>;
  readonly fields: readonly (keyof CRow & string)[];
  readonly filterable: F;
  readonly sortable: readonly S[];
  column(field: NoInfer<(keyof F & string) | S>): LiveColumnRef;
};

/**
 * Build a typed set's shared parts. `self` answers the finished handle (the
 * caller's object, completed with its owner and `read`) — what a minted ref
 * carries, read when a ref is minted, never during construction.
 */
export function typedColumns<CRow, F, S extends string>(
  owner: LiveColumnsOwner,
  name: string,
  spec: { row: LiveRowSchema<CRow>; filterable: F; sortable: readonly S[] },
  fail: (message: string) => never,
  self: () => LiveColumnsDeclaration,
): TypedColumnsParts<CRow, F, S> {
  const fields = Object.keys(spec.row.shape) as (keyof CRow & string)[];
  const filterable = spec.filterable as unknown as Record<string, FilterColumn>;
  for (const f of [...Object.keys(filterable), ...spec.sortable]) {
    if (!fields.includes(f as keyof CRow & string)) {
      fail(`"${f}" is not a field of its row schema`);
    }
  }
  const wireName = (field: string): string => `${name}.${field}`;
  const wireFilterable: Filterable = Object.fromEntries(
    Object.entries(filterable).map(([f, col]) => [wireName(f), col]),
  );
  const wireSortable = spec.sortable.map((f) => wireName(f));
  const parts: TypedColumnsParts<CRow, F, S> = {
    kind: "live-columns",
    name,
    row: spec.row,
    fields,
    rowShape: spec.row.shape as Readonly<Record<string, unknown>>,
    filterable: spec.filterable,
    sortable: spec.sortable,
    wireName,
    wireFilterable,
    wireSortable,
    column: (field) => {
      const declared = Object.hasOwn(filterable, field)
        ? filterable[field]
        : undefined;
      const sortable = (spec.sortable as readonly string[]).includes(field);
      if (declared === undefined && !sortable) {
        fail(
          `column("${field}"): not a declared filterable or sortable column`,
        );
      }
      return mintColumnRef({
        owner,
        name: wireName(field),
        domain: declared?.domain ?? null,
        sortable,
        handle: self(),
      });
    },
  };
  return parts;
}

// ── Arm column sets: one arm's own columns on a union collection ───────────
// An `arms` collection (`liveCollection(key, { arms: { discriminator } })`)
// lists rows of N kinds in one window — the runs of every run kind. The base
// fields are every arm's; each arm's OWN fields (a build's exit code, a
// backup's archive size) ride its rows under `$columns[<arm>]`, declared here
// in the arm's core (browser-safe) and served by the union's server half. A
// row of another arm carries no slice for it: `read` answers `null` there,
// and throws when its own arm's row lacks one (A16) — a server that did not
// fold the arm is a bug, never "no values".

/** One arm's own columns on an `arms` collection (see {@link liveArmColumns}). */
export interface LiveArmColumnsHandle<
  Row,
  CRow,
  F,
  S extends string,
> extends LiveColumnsDeclaration {
  readonly owner: {
    readonly kind: "arm";
    readonly collection: string;
    readonly arm: string;
  };
  /** The arm's fields, parsed by `read`. */
  readonly row: LiveRowSchema<CRow>;
  readonly fields: readonly (keyof CRow & string)[];
  /** Field → filter domain (by FIELD name). */
  readonly filterable: F;
  readonly sortable: readonly S[];
  /** A column ref a list binds a field to (`FieldDef.column`), carrying this handle. */
  column(field: NoInfer<(keyof F & string) | S>): LiveColumnRef;
  /**
   * This arm's slice of a row, parsed (once per row object) — `null` for a
   * row of another arm. Throws on a row of this arm that carries no slice.
   */
  read(row: Row): CRow | null;
}

/**
 * Declare one arm's own columns on an `arms` collection (a collection without
 * `arms` is a tsc error, and throws). `arm` is the arm's kind — the value its
 * rows carry in the collection's discriminator — and every wire name's prefix
 * (`<arm>.<field>`). Browser-safe and registers nothing: the union's server
 * half binds and folds it.
 */
export function liveArmColumns<
  Row,
  F0,
  S0 extends string,
  D extends keyof Row & string,
  CRow,
  const F extends LiveFilterable<CRow>,
  const S extends keyof CRow & string = never,
>(
  collection: LiveArmsCollection<Row, F0, S0, D>,
  arm: string,
  spec: {
    row: LiveRowSchema<CRow>;
    filterable: F;
    sortable: readonly S[];
  },
): LiveArmColumnsHandle<WithContributedColumns<Row>, CRow, F, S> {
  const fail = (message: string): never => {
    throw new Error(
      `liveArmColumns("${collection.key}", "${arm}"): ${message}`,
    );
  };
  const arms = (collection as { arms?: { discriminator: string } | null }).arms;
  if (arms === undefined || arms === null) {
    fail("the collection is not declared with `arms`");
  }
  if (!KIND_RE.test(arm)) {
    fail(`an arm is a plain identifier (${String(KIND_RE)})`);
  }
  const discriminator = arms!.discriminator;
  const owner = { kind: "arm", collection: collection.key, arm } as const;
  const parts = typedColumns(owner, arm, spec, fail, () => handle);
  const parsed = new WeakMap<object, CRow>();
  const handle: LiveArmColumnsHandle<
    WithContributedColumns<Row>,
    CRow,
    F,
    S
  > = {
    ...parts,
    owner,
    read: (row) => {
      const of = (row as Record<string, unknown>)[discriminator];
      if (of !== arm) return null;
      const cached = parsed.get(row);
      if (cached !== undefined) return cached;
      const slice = row.$columns[arm];
      if (slice === undefined) {
        return fail(
          `a "${arm}" row carries no "${arm}" slice under \`$columns\` — the union's server half did not fold this arm's columns (A16)`,
        );
      }
      const value = spec.row.parse(slice);
      parsed.set(row, value);
      return value;
    },
  };
  return handle;
}

// ── Scoped column sets: an open vocabulary per scope ───────────────────────
// A collection declared with a `columnScope` (the DataView surface it is listed
// on) can be sorted and filtered by columns whose set is not code but data —
// a surface's custom columns, defined in its config. Their server half is a
// `LiveColumns.Scoped` contribution (the side table they live in, and the
// members a scope has now); this is the browser half: a declaration built from
// the members the client knows, handed to the codec like any contributed set.
// The server decodes a tuple against the members IT has, strictly.

/** One member of a scoped set, as a query may name it. */
export interface ScopedColumnMember {
  /** The filter domain its values read in; `null` = not filterable. */
  domain: FilterColumn["domain"] | null;
  sortable: boolean;
}

/** A scoped column set: its declaration, and the refs a list binds its fields to. */
export interface LiveScopedColumns extends LiveColumnsDeclaration {
  readonly owner: { readonly kind: "scoped"; readonly scope: string };
  /** A member as a list binds a field to it (`FieldDef.column`); a ref naming its scope. */
  column(member: string): LiveColumnRef;
}

/**
 * Declare the members of a scoped column set as they stand (`name` is its
 * server contribution's — `LiveColumns.Scoped` — and every wire name's prefix:
 * `<name>.<member>`). Browser-safe, registers nothing; rebuilt whenever the
 * members change (a query built from it names exactly the members it knew).
 */
export function scopedLiveColumns(
  scope: string,
  name: string,
  members: Readonly<Record<string, ScopedColumnMember>>,
): LiveScopedColumns {
  const fail = (message: string): never => {
    throw new Error(`scopedLiveColumns("${scope}", "${name}"): ${message}`);
  };
  if (!KIND_RE.test(name)) {
    fail("a column set's name is a plain identifier (no `.`)");
  }
  for (const member of Object.keys(members)) {
    if (member === "" || member.includes(".")) {
      fail(`member "${member}" must be non-empty and carry no "."`);
    }
  }
  const wireName = (member: string): string => `${name}.${member}`;
  const wireFilterable: Filterable = Object.fromEntries(
    Object.entries(members)
      .filter(([, m]) => m.domain !== null)
      .map(([member, m]) => [
        wireName(member),
        { domain: m.domain } as FilterColumn,
      ]),
  );
  const wireSortable = Object.entries(members)
    .filter(([, m]) => m.sortable)
    .map(([member]) => wireName(member));
  const owner = { kind: "scoped", scope } as const;
  const handle: LiveScopedColumns = {
    kind: "live-columns",
    owner,
    name,
    fields: Object.keys(members),
    rowShape: {},
    wireName,
    wireFilterable,
    wireSortable,
    column: (member) => {
      const m = Object.hasOwn(members, member) ? members[member] : undefined;
      if (m === undefined) fail(`column("${member}"): not a member`);
      if (m!.domain === null && !m!.sortable) {
        fail(`column("${member}"): neither filterable nor sortable`);
      }
      return mintColumnRef({
        owner,
        name: wireName(member),
        domain: m!.domain,
        sortable: m!.sortable,
        handle,
      });
    },
  };
  return handle;
}
