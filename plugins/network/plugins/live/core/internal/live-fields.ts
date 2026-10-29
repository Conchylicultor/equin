import {
  fieldsToZodObject,
  type FieldDef,
  type FieldOptionMeta,
  type FieldsRecord,
  type InferFieldValue,
  type Labelled,
} from "@plugins/fields/core";
import type { z } from "zod";
import type {
  EntityRef,
  PresentationReadsOf,
} from "@plugins/infra/plugins/entities/core";
import type { AnyExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import type {
  Filter,
  Filterable,
  FilterColumn,
  FilterDomainId,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { fieldDomain, type FieldsFilterable } from "./field-domain";

// A collection's FIELDS — the new spelling (phase 2 of fields-declared-once,
// `research/2026-10-13-global-fields-declared-once-phase2.md` §2): a
// collection names the entity its rows are (`from`), the fields of it a list
// shows (`pick`), the entities its rows reach (`related`) and the fields it
// computes itself (`fields`) — and the rest is DERIVED: the row schema (the
// fields' wire schemas), the filter domains (`./field-domain`), the labels,
// types and options every list and the MCP read off `collection.fields`.
// `carry` puts fields on the row a list does not show (an id, a foreign key).
// The fields `from`'s presentation reads (`entityRef`'s `presentationReads`)
// are carried on every row by construction, whether or not `carry` names them.
// `from` is an entity or an entity EXTENSION's shape (a side table's own
// field record): a shape's rows carry its whole wire row, and `pick` lists
// some of its fields.

/** One field of a live row set, as every list shows it — derived from its `FieldDef`. */
export interface LiveField {
  /** Its id in every list — what a saved view, a filter preset and an override name. */
  readonly id: string;
  /** Where the row holds its value: a row key (an own field), a `$columns` slice key (an exposure's, an arm's). */
  readonly key: string;
  readonly label: string;
  /** The field TYPE's id (`fields`' type token: `"text"`, `"int"`, `"date"`, …). */
  readonly typeId: string;
  /** Each value's presentation (an enum's options), `null` for an open set. */
  readonly options: Readonly<Record<string, FieldOptionMeta>> | null;
  /** The row's title field — what a list names each row by. */
  readonly primary: boolean;
  /** The filter domain its values read in; `null` = not filterable. */
  readonly domain: FilterDomainId | null;
  /** Its column sorts (declared `sortable`). */
  readonly sortable: boolean;
}

// The phantom a field set's ids ride on — a symbol, so it never collides
// with a field id (and never exists at runtime).
declare const FIELD_IDS: unique symbol;

/** A collection's listed fields, by id, in declaration order. */
export type LiveFields<Id extends string = string> = Readonly<
  Record<Id, LiveField>
> & { readonly [FIELD_IDS]?: Id };

/**
 * The ids of the fields a collection (or a field set) lists — what an
 * override by id is typed against (data-view's `overrides`). `never` for a
 * collection in the old `row` spelling.
 */
export type LiveFieldIds<C> = C extends { readonly fields: infer FS }
  ? FS extends { readonly [FIELD_IDS]?: infer Id }
    ? Exclude<Id, undefined> extends infer I extends string
      ? string extends I
        ? never
        : I
      : never
    : never
  : never;

/** What a collection's rows reach beyond its own entity: a lookup join's alias → the entity it reads. */
export type LiveRelated = Readonly<Record<string, EntityRef>>;

/**
 * What a collection's rows are (`from`): an entity, or an entity extension's
 * shape (`defineExtensionShape` — a 1:1 side table, its field record declared
 * once in core). A shape's rows carry its whole WIRE row (`shape.schema`'s
 * keys); an entity's carry only the fields picked or carried by name.
 */
export type LiveFrom = EntityRef | AnyExtensionShape;

/** The field record of `from` (none without one). */
export type FromFields<E> = [E] extends [EntityRef<string, infer F>]
  ? F
  : [E] extends [AnyExtensionShape]
    ? E["fields"]
    : Record<never, never>;

/** `collection.from`: the entity a collection's rows are — `null` for a shape's or none. */
export type FromEntity<E> = [E] extends [EntityRef] ? E : null;

/** The fields of `F` declared with a label — the ones a list may show (`RequireLabel`). */
export type LabelledKeys<F> = {
  [K in keyof F & string]: F[K] extends Labelled ? K : never;
}[keyof F & string];

/**
 * `RequireLabel`: every field of an own `fields` record carries a label, or
 * that field is a tsc error — a list never shows a field it cannot name. A
 * field the row carries but no list shows goes in `carry`.
 */
export type RequireLabel<F> = {
  [K in keyof F]: F[K] extends Labelled ? F[K] : F[K] & Labelled;
};

/** A record's row: each field's value. */
type RowOfFields<F> = { [K in keyof F]: InferFieldValue<F[K]> };

type Flatten<T> = { [K in keyof T]: T[K] };

/** The listed fields: the picked ones of `from` and the own ones. */
export type ListedFields<E, P extends string, OF> = Pick<
  FromFields<E>,
  P & keyof FromFields<E>
> &
  OF;

/**
 * What `from`'s presentation reads beside a field it presents — only when the
 * collection presents one (`pick` lists a field of `from`): a collection that
 * shows none of the entity's fields (a follow target, a carry-only lookup)
 * carries exactly what it names, so no presentation column widens its gate.
 */
type PresentedReads<E, P extends string> = [P] extends [never]
  ? never
  : PresentationReadsOf<E>;

/** Every field on the row: the listed ones, the carried ones and the ones `from`'s presentation reads. */
export type RowFields<E, P extends string, CP extends string, OF, CF> = Pick<
  FromFields<E>,
  (P | CP | PresentedReads<E, P>) & keyof FromFields<E>
> &
  OF &
  CF;

/**
 * The row a fields spec derives: over a shape, its wire row and the own /
 * carried fields (a carried field named like a shape column decodes it);
 * otherwise every row field's value.
 */
export type FieldsRow<E, P extends string, CP extends string, OF, CF> = [
  E,
] extends [EntityRef]
  ? Flatten<RowOfFields<RowFields<E, P, CP, OF, CF>>>
  : [E] extends [AnyExtensionShape]
    ? Flatten<
        Omit<z.infer<E["schema"]>, keyof (OF & CF)> & RowOfFields<OF & CF>
      >
    : Flatten<RowOfFields<RowFields<E, P, CP, OF, CF>>>;

/** The filterable columns a fields spec derives: every listed field with a domain. */
export type FieldsSpecFilterable<E, P extends string, OF> = Flatten<
  FieldsFilterable<ListedFields<E, P, OF>>
>;

/** Whether a fields spec's rows carry `$columns` (it reaches an entity). */
export type FieldsSpecExposes<E, R, B> = [E] extends [EntityRef]
  ? [B] extends [false]
    ? [R] extends [LiveRelated]
      ? true
      : undefined
    : true
  : [R] extends [LiveRelated]
    ? true
    : undefined;

/**
 * The field half of a collection declaration in the new spelling (see the
 * file comment). Every key but `id` is optional; a collection over no entity
 * declares only `fields` (and `carry.fields`).
 */
export interface LiveFieldsSpec<
  E extends LiveFrom | undefined,
  P extends string,
  CP extends string,
  OF extends FieldsRecord,
  CF extends FieldsRecord,
  R extends LiveRelated | undefined,
> {
  /**
   * The entity the rows are: `pick` reads its fields, and every extension
   * exposing fields of it folds into the rows (`exposes.base`) — unless
   * `baseExposures: false`. Or an extension's shape: its whole wire row is
   * on the rows, `pick` lists some of it, and it reaches no exposure.
   */
  from?: E;
  /** The fields of `from` a list shows, in list order — each must carry a label (tsc). */
  pick?: readonly P[];
  /**
   * The entities the rows reach through a lookup join its server half
   * declares, by the join's alias (`{ task: tasksEntityRef }`): every
   * extension exposing fields of one folds into the rows.
   */
  related?: R;
  /**
   * Fields the collection computes itself (the server binds each by a join or
   * an expression — `serveCollection`'s `columns`), listed after the picked
   * ones — each must carry a label (`RequireLabel`, tsc).
   */
  fields?: OF;
  /**
   * Fields the row carries that no list shows (an id, a foreign key, a
   * lifecycle stamp): `pick` from `from`, `fields` of its own. Never
   * filterable.
   */
  carry?: { pick?: readonly CP[]; fields?: CF };
  /**
   * `false`: the base entity's exposures stay off the rows (a boot-preloaded
   * set whose base exposure is write-hot — every write would push a diff to
   * every client). The `related` ones still fold.
   */
  baseExposures?: false;
  /**
   * The most ids one `:rows` tuple (`useLive(c, { ids })`, `useLiveRow`,
   * `useOptimisticResource(c, { ids })`) may name: the point codec's `encode`
   * throws past it, and its `decode` — the params gate and the membership
   * `idsOf` — refuses it as `contract-mismatch`, so an id set is a bounded read
   * like a window. Default: a window's `maxLimit`, an `all` set's `max`, else
   * `LIVE_DEFAULT_MAX_IDS` (500). Declare it where a reader's id set is known
   * to be larger (the queue reads the ranks of every live conversation).
   */
  maxIds?: number;
  /**
   * The collection's BASE membership as data — the rows of `from` it holds —
   * a filter over its listed fields (`and(clause("status", "ne", "done"), …)`).
   * One declaration both runtimes read: `serveCollection` renders it with the
   * filter language's `filterSql` (ANDed with the serve call's `where`, if
   * any), and the browser re-checks a row against it (`matchesFilter`) — a
   * predicted write (`patchRow`) that moves a row out of it removes the row
   * at once. Each column it names must bind to the base table's column of
   * the same name (not through `columns`), so the value the client tests is
   * the value the SQL tests. Mind the language's semantics: a negative op
   * (`ne`, `notIn`, …) KEEPS NULL, unlike SQL's `<>`. Not on a union.
   */
  // `NoInfer`: checked against the fields, never a source of their types —
  // so its clause literals stay narrow while `from` / `pick` infer.
  membership?: NoInfer<MembershipOf<FieldsSpecFilterable<E, P, OF>>>;
  /** The old spelling's — `row` / `filterable` / `exposes` are derived here. */
  row?: never;
  filterable?: never;
  exposes?: never;
}

/** A membership filter over a spec's filterable columns. */
export type MembershipOf<F> = F extends Filterable ? Filter<F> : never;

/** What a fields spec derives, for the declaration to mint from. */
export interface ResolvedFieldsSpec {
  /** The row schema: every row field's wire schema (with its default backfill). */
  readonly row: ReturnType<typeof fieldsToZodObject>;
  /** The listed fields with a filter domain, by key → their column. */
  readonly filterable: Readonly<Record<string, FilterColumn>>;
  /** `base` → `from`, then every `related` alias; `null` when the rows reach no entity. */
  readonly exposes: Readonly<Record<string, EntityRef>> | null;
  /** The listed fields' descriptors, sortable per `sortable`. */
  readonly fields: (sortable: readonly string[]) => LiveFields;
}

/** The spec keys that make a declaration the new spelling. */
const FIELD_SPEC_KEYS = [
  "from",
  "pick",
  "related",
  "fields",
  "carry",
  "baseExposures",
] as const;

/** Whether a declaration uses the fields spelling (any of its keys set). */
export function isFieldsSpec(spec: object): boolean {
  return FIELD_SPEC_KEYS.some(
    (k) => (spec as Record<string, unknown>)[k] !== undefined,
  );
}

/**
 * Resolve a fields spec (see {@link LiveFieldsSpec}): what tsc already refuses
 * is checked again here for an untyped caller — a picked key that is not a
 * field of `from`, a listed field with no label, the old spelling's keys
 * beside it, a field named twice, `pick` or `baseExposures` without `from`,
 * an `id` that is no row field.
 */
export function resolveFieldsSpec(
  key: string,
  spec: LiveFieldsSpec<
    LiveFrom | undefined,
    string,
    string,
    FieldsRecord,
    FieldsRecord,
    LiveRelated | undefined
  > & { id: string },
): ResolvedFieldsSpec {
  const fail = (message: string): never => {
    throw new Error(`liveCollection("${key}"): ${message}`);
  };
  const stray = (["row", "filterable", "exposes"] as const).filter(
    (k) => (spec as unknown as Record<string, unknown>)[k] !== undefined,
  );
  if (stray.length > 0) {
    fail(
      `${stray.join(", ")} beside the fields spelling (\`from\` / \`pick\` / \`fields\`) — the row, its filter domains and the entities it reaches are derived from the fields.`,
    );
  }
  const from = spec.from;
  const shape = from !== undefined && isShape(from) ? from : undefined;
  if (
    from !== undefined &&
    shape === undefined &&
    (from as { kind?: unknown }).kind !== "entity"
  ) {
    fail(
      "`from` is neither an EntityRef (`entityRef(name, fields)`) nor an extension shape (`defineExtensionShape`).",
    );
  }
  if (from === undefined && (spec.pick ?? spec.carry?.pick) !== undefined) {
    fail("`pick` without `from` — a picked field is one of `from`'s.");
  }
  if (shape === undefined || from === undefined) {
    if (from === undefined && spec.baseExposures !== undefined) {
      fail("`baseExposures` without `from` — there is no base entity to fold.");
    }
  } else {
    if (spec.baseExposures !== undefined) {
      fail(
        "`baseExposures` over an extension shape — a shape's rows reach no exposure.",
      );
    }
    if (spec.carry?.pick !== undefined) {
      fail(
        "`carry.pick` over an extension shape — its whole wire row is carried already.",
      );
    }
  }
  const ownerName =
    shape !== undefined
      ? `extension shape (key "${shape.key}")`
      : `entity "${(from as EntityRef | undefined)?.name}"`;
  const listed: [string, FieldDef][] = [];
  const carried: [string, FieldDef][] = [];
  const seen = new Set<string>();
  const add = (
    into: [string, FieldDef][],
    name: string,
    field: FieldDef | undefined,
    where: string,
  ): void => {
    if (field === undefined) {
      fail(
        `${where} names "${name}", which is not a wire field of ${ownerName}.`,
      );
    }
    if (seen.has(name)) fail(`"${name}" is declared twice (${where}).`);
    seen.add(name);
    into.push([name, field!]);
  };
  const fromField = (name: string): FieldDef | undefined =>
    from !== undefined &&
    Object.hasOwn(from.fields, name) &&
    (shape === undefined || Object.hasOwn(shape.schema.shape, name))
      ? from.fields[name]
      : undefined;
  for (const name of spec.pick ?? [])
    add(listed, name, fromField(name), "`pick`");
  // A shape's rows are its whole wire row: what no list shows is carried —
  // in its own field, unless `carry.fields` decodes the column (a stored rank
  // key carried as the wire `Rank`, `rankValueField`), as over an entity.
  if (shape !== undefined) {
    const decoded = spec.carry?.fields ?? {};
    for (const name of Object.keys(shape.schema.shape)) {
      if (!seen.has(name) && !Object.hasOwn(decoded, name))
        add(carried, name, fromField(name), "the shape");
    }
  }
  for (const [name, field] of Object.entries(spec.fields ?? {})) {
    if (from !== undefined && Object.hasOwn(from.fields, name)) {
      fail(
        `own field "${name}" is named like a field of ${ownerName} — pick it, or name it apart.`,
      );
    }
    add(listed, name, field, "`fields`");
  }
  for (const name of spec.carry?.pick ?? []) {
    add(carried, name, fromField(name), "`carry.pick`");
  }
  for (const [name, field] of Object.entries(spec.carry?.fields ?? {})) {
    add(carried, name, field, "`carry.fields`");
  }
  // What the entity's presentation reads beside the field it presents rides
  // on every row that presents one — never restated per collection, so none
  // can miss one. A collection listing none of its fields presents nothing:
  // it carries exactly what it names (`PresentedReads`).
  if (
    shape === undefined &&
    from !== undefined &&
    (spec.pick ?? []).length > 0
  ) {
    for (const name of (from as EntityRef).presentationReads) {
      if (!seen.has(name)) add(carried, name, fromField(name), "the entity");
    }
  }
  for (const [name, field] of listed) {
    const label = field.meta.label;
    if (label === undefined || label.trim().length === 0) {
      fail(
        `listed field "${name}" has no label — declare it with one (\`{ label }\`), or \`carry\` it if no list shows it.`,
      );
    }
  }
  if (!seen.has(spec.id)) {
    fail(
      `the id "${spec.id}" is not a field of the row — \`carry\` it (\`carry: { pick: ["${spec.id}"] }\`).`,
    );
  }
  const filterable: Record<string, FilterColumn> = {};
  for (const [name, field] of listed) {
    const domain = fieldDomain(field);
    if (domain !== null) filterable[name] = { domain } as FilterColumn;
  }
  const exposes: Record<string, EntityRef> = {};
  if (from !== undefined && shape === undefined && spec.baseExposures !== false)
    exposes.base = from as EntityRef;
  for (const [alias, ref] of Object.entries(spec.related ?? {})) {
    if (alias === "base") {
      fail("`related` names `base` — the base entity is `from`.");
    }
    exposes[alias] = ref;
  }
  const row = fieldsToZodObject(
    Object.fromEntries([...listed, ...carried]) as FieldsRecord,
  );
  return {
    row,
    filterable,
    exposes: Object.keys(exposes).length === 0 ? null : exposes,
    fields: (sortable) =>
      Object.freeze(
        Object.fromEntries(
          listed.map(([name, field]) => [
            name,
            Object.freeze({
              id: name,
              key: name,
              label: field.meta.label!,
              typeId: field.type.id,
              options:
                field.meta.optionMeta === undefined
                  ? null
                  : field.meta.optionMeta,
              primary: field.meta.primary === true,
              domain: filterable[name]?.domain ?? null,
              sortable: sortable.includes(name),
            } satisfies LiveField),
          ]),
        ),
      ),
  };
}

/** Whether `from` is an extension shape (its wire row is `schema`), not an entity ref. */
export function isShape(from: LiveFrom): from is AnyExtensionShape {
  return (from as { kind?: unknown }).kind !== "entity" && "schema" in from;
}
