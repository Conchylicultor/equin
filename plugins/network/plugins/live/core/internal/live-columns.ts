import type {
  FilterColumn,
  Filterable,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { KIND_RE } from "@plugins/infra/plugins/query-resource/core";
import type { LiveArmsCollection, LiveRowSchema } from "./live-collection";
import { mintColumnRef, type LiveColumnRef } from "./column-ref";
import type { LiveFilterable } from "./query";
import {
  fieldsToZodObject,
  type FieldsRecord,
  type InferFieldValue,
} from "@plugins/fields/core";
import { fieldDomain, type FieldsFilterable } from "./field-domain";
import {
  isShape,
  type FromFields,
  type LabelledKeys,
  type LiveField,
  type LiveFields,
  type LiveFrom,
  type RequireLabel,
} from "./live-fields";

// Column sets: the fields a row carries under `$columns`, beside its own —
// an entity extension's exposed fields (`exposedColumns`), a union arm's own
// fields (`liveArm`), a surface's custom columns (`scopedLiveColumns`). Each
// set is a DECLARATION (browser-safe, nothing registered) that its readers —
// the codec, the server compile, a list — read generically; a query naming a
// set's columns hands the codec the declarations it reads, so encoding
// validates against them.

/** The reserved row field a row carries its column sets' values under (by set name). */
export const LIVE_COLUMNS_KEY = "$columns";

/**
 * The reserved WINDOW-only field a scoped collection's rows carry the scoped
 * columns their tuple ORDERS BY under (by the server's join alias) — so the
 * order signature sees a member's value move. Not a row field: every read hands
 * rows out without it, like `$key`.
 */
export const LIVE_SCOPED_KEY = "$scoped";

/**
 * A row's column-set values: set name → its fields. Opaque to everyone but
 * the sets, which parse their own slice (`set.read(row)`).
 */
export type ContributedColumns = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

/** A row carrying column sets: the author's row, plus every set's values. */
export type WithContributedColumns<Row> = Row & {
  readonly $columns: ContributedColumns;
};

/**
 * Who a column set belongs to — and so which collection may read it. Every
 * reader switches on it exhaustively (T11): a fourth kind of set is a tsc
 * error at each site that must decide what it means there.
 *
 * - `scoped` — a data-defined set (`scopedLiveColumns`), read by whichever
 *   collection declares `scope` as its `columnScope`;
 * - `arm` — one arm's own fields on an `arms` (union) collection
 *   (`liveArm`), present only on that arm's rows;
 * - `exposed` — an entity extension's exposed fields (`exposedColumns`), read
 *   by every collection whose `exposes` reaches `entity`.
 */
export type LiveColumnsOwner =
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
 * column ref — with its row type erased. A typed {@link LiveArmColumnsHandle}
 * is one.
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
  /** Every field the set projects (its row schema's keys). */
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
 * What a typed column set (an arm's) has: its declaration, its row schema and
 * filter / sort vocabulary, and the refs a list binds to.
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
// backup's archive size) ride its rows under `$columns[<arm>]`, declared in
// the arm's core (`liveArm`, browser-safe) and served by the union's server
// half. A row of another arm carries no slice for it: `read` answers `null`
// there, and throws when its own arm's row lacks one (A16) — a server that
// did not fold the arm is a bug, never "no values".

/** One arm's own columns on an `arms` collection (see {@link liveArm}). */
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
 * An arm's column set from its row schema and filter / sort vocabulary —
 * `liveArm`'s substrate (a collection without `arms` is a tsc error, and
 * throws). `arm` is the arm's kind — the value its rows carry in the
 * collection's discriminator — and every wire name's prefix
 * (`<arm>.<field>`). Browser-safe and registers nothing: the union's server
 * half binds and folds it.
 */
function armColumns<
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
    throw new Error(`liveArm("${collection.key}", "${arm}"): ${message}`);
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
// the members the client knows, handed to the codec like any other set.
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

// ── Arms in the fields spelling ─────────────────────────────────────────────
// An arm is declared by FIELDS (phase 2 of fields-declared-once): it names
// its fields once — each with its label and options — and the rest is
// derived: the slice's row schema, each field's
// filter domain (`./field-domain`), and the descriptors every list of the
// union shows (`listed`, ids `<arm>.<field>`, under the arm's `label`).

/** One arm of a union collection declared by fields (see {@link liveArm}). */
export interface LiveArm<
  Row,
  F extends FieldsRecord,
  S extends string,
  C extends FieldsRecord = Record<never, never>,
  Pk extends string = never,
> extends LiveArmColumnsHandle<
  Row,
  { [K in keyof (F & C)]: InferFieldValue<(F & C)[K]> },
  FieldsFilterable<F>,
  S
> {
  /** The arm's name in every list — the band its fields are listed under (`"Build"`). */
  readonly label: string;
  /**
   * Where its band (and its kind among the kind options) sits among the
   * union's arms, ascending — each arm states its own place, so the order is
   * one the surface chose, never the plugins' load order.
   */
  readonly order: number;
  /** The fields every list of the union shows for this arm, by id (`<arm>.<field>`), in declaration order. */
  readonly listed: LiveFields<`${string}.${keyof F & string}`>;
  /**
   * The fields it reads from its entity by name (`pick`) — listed like its own,
   * and bound by name on the server (the arm's table is the entity's), so its
   * binding names only its own fields.
   */
  readonly picked: readonly Pk[];
}

/**
 * Declare one arm's own fields on an `arms` collection — a Meta-DataView's
 * source — by field: `label` is the arm's (the band its fields are listed
 * under), each field carries its own (tsc, `RequireLabel`), and `sortable`
 * stays explicit (index-backed). Every field with a filter domain filters in
 * it. `carry` puts fields on the arm's slice that no list shows (a jsonb blob
 * a detail pane decodes): never listed, filtered or sorted.
 *
 * An arm whose rows ARE an entity's (or an extension shape's) names it in
 * `from` and lists some of its fields by name in `pick` — declared once, on
 * the entity, with their labels and options — before its own `fields`; its
 * server binding then binds the picked ones by name.
 */
export function liveArm<
  Row,
  F0,
  S0 extends string,
  D extends keyof Row & string,
  const E extends LiveFrom | undefined = undefined,
  const P extends LabelledKeys<FromFields<E>> = never,
  const F extends FieldsRecord = Record<never, never>,
  const S extends (keyof F & string) | P = never,
  const C extends FieldsRecord = Record<never, never>,
>(
  collection: LiveArmsCollection<Row, F0, S0, D>,
  arm: string,
  spec: {
    label: string;
    /** Its band's place among the union's arms, ascending ({@link LiveArm.order}). */
    order: number;
    /** The entity (or extension shape) its rows are — `pick` reads its fields. */
    from?: E;
    /** The fields of `from` a list shows, before the arm's own — each labelled (tsc). */
    pick?: readonly P[];
    fields?: F & RequireLabel<F>;
    carry?: C;
    sortable?: readonly S[];
  },
): LiveArm<
  WithContributedColumns<Row>,
  Pick<FromFields<E>, P & keyof FromFields<E>> & F,
  S,
  C,
  P
> {
  const fail = (message: string): never => {
    throw new Error(`liveArm("${collection.key}", "${arm}"): ${message}`);
  };
  if (spec.label.trim().length === 0) fail("`label` is empty.");
  if (!Number.isFinite(spec.order)) fail("`order` is not a finite number.");
  const from = spec.from;
  if (
    from !== undefined &&
    !isShape(from) &&
    (from as { kind?: unknown }).kind !== "entity"
  ) {
    fail(
      "`from` is neither an EntityRef (`entityRef(name, fields)`) nor an extension shape (`defineExtensionShape`).",
    );
  }
  if (from === undefined && spec.pick !== undefined) {
    fail("`pick` without `from` — a picked field is one of `from`'s.");
  }
  // The listed fields: the picked ones of `from` (by name, in pick order),
  // then the arm's own — one record, so every derivation below reads it.
  const listedFields: FieldsRecord = {};
  for (const name of spec.pick ?? []) {
    const field =
      from !== undefined &&
      Object.hasOwn(from.fields, name) &&
      (!isShape(from) || Object.hasOwn(from.schema.shape, name))
        ? (from.fields as FieldsRecord)[name]
        : undefined;
    if (field === undefined) {
      fail(`\`pick\` names "${name}", which is not a wire field of \`from\`.`);
    }
    if (Object.hasOwn(listedFields, name)) {
      fail(`\`pick\` names "${name}" twice.`);
    }
    listedFields[name] = field!;
  }
  for (const [name, field] of Object.entries(spec.fields ?? {})) {
    if (from !== undefined && Object.hasOwn(from.fields, name)) {
      fail(
        `own field "${name}" is named like a field of \`from\` — pick it, or name it apart.`,
      );
    }
    listedFields[name] = field;
  }
  const carried = spec.carry ?? ({} as C);
  for (const name of Object.keys(carried)) {
    if (Object.hasOwn(listedFields, name)) {
      fail(`"${name}" is both a listed and a carried field.`);
    }
  }
  const filterable: Record<string, FilterColumn> = {};
  for (const [name, field] of Object.entries(listedFields)) {
    const label = field.meta.label;
    if (label === undefined || label.trim().length === 0) {
      fail(
        `field "${name}" has no label — declare it with one (\`{ label }\`), or \`carry\` it if no list shows it.`,
      );
    }
    const domain = fieldDomain(field);
    if (domain !== null) filterable[name] = { domain } as FilterColumn;
  }
  const sortable = spec.sortable ?? [];
  type Listed = Pick<FromFields<E>, P & keyof FromFields<E>> & F;
  type Slice = { [K in keyof (Listed & C)]: InferFieldValue<(Listed & C)[K]> };
  const handle = armColumns(collection, arm, {
    row: fieldsToZodObject({
      ...listedFields,
      ...carried,
    }) as unknown as LiveRowSchema<Slice>,
    filterable: filterable as unknown as FieldsFilterable<Listed> &
      LiveFilterable<Slice>,
    sortable,
  });
  const listed = Object.freeze(
    Object.fromEntries(
      Object.entries(listedFields).map(([name, field]) => {
        const id = `${arm}.${name}`;
        const descriptor: LiveField = Object.freeze({
          id,
          key: name,
          label: field.meta.label!,
          typeId: field.type.id,
          options: field.meta.optionMeta ?? null,
          primary: field.meta.primary === true,
          domain: filterable[name]?.domain ?? null,
          sortable: (sortable as readonly string[]).includes(name),
        });
        return [id, descriptor];
      }),
    ),
  ) as LiveFields<`${string}.${keyof F & string}`>;
  return Object.assign(handle, {
    label: spec.label,
    order: spec.order,
    listed,
    picked: Object.freeze([...(spec.pick ?? [])]),
  }) as unknown as LiveArm<
    WithContributedColumns<Row>,
    Pick<FromFields<E>, P & keyof FromFields<E>> & F,
    S,
    C,
    P
  >;
}
