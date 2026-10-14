import {
  fieldsToZodObject,
  type FieldDef,
  type FieldOptionMeta,
  type FieldsRecord,
  type InferFieldValue,
  type Labelled,
} from "@plugins/fields/core";
import type { EntityRef } from "@plugins/infra/plugins/entities/core";
import type {
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

/** The field record of `from` (none without one). */
export type FromFields<E> = [E] extends [EntityRef<string, infer F>]
  ? F
  : Record<never, never>;

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

/** Every field on the row: the listed ones and the carried ones. */
export type RowFields<E, P extends string, CP extends string, OF, CF> = Pick<
  FromFields<E>,
  (P | CP) & keyof FromFields<E>
> &
  OF &
  CF;

/** The row a fields spec derives. */
export type FieldsRow<E, P extends string, CP extends string, OF, CF> = Flatten<
  RowOfFields<RowFields<E, P, CP, OF, CF>>
>;

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
  E extends EntityRef | undefined,
  P extends string,
  CP extends string,
  OF extends FieldsRecord,
  CF extends FieldsRecord,
  R extends LiveRelated | undefined,
> {
  /**
   * The entity the rows are: `pick` reads its fields, and every extension
   * exposing fields of it folds into the rows (`exposes.base`) — unless
   * `baseExposures: false`.
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
  /** The old spelling's — `row` / `filterable` / `exposes` are derived here. */
  row?: never;
  filterable?: never;
  exposes?: never;
}

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
    EntityRef | undefined,
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
  if (from !== undefined && from?.kind !== "entity") {
    fail("`from` is not an EntityRef (`entityRef(name, fields)`).");
  }
  if (from === undefined && (spec.pick ?? spec.carry?.pick) !== undefined) {
    fail("`pick` without `from` — a picked field is one of `from`'s.");
  }
  if (from === undefined && spec.baseExposures !== undefined) {
    fail("`baseExposures` without `from` — there is no base entity to fold.");
  }
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
        `${where} names "${name}", which is not a field of entity "${from?.name}".`,
      );
    }
    if (seen.has(name)) fail(`"${name}" is declared twice (${where}).`);
    seen.add(name);
    into.push([name, field!]);
  };
  const fromField = (name: string): FieldDef | undefined =>
    from !== undefined && Object.hasOwn(from.fields, name)
      ? from.fields[name]
      : undefined;
  for (const name of spec.pick ?? [])
    add(listed, name, fromField(name), "`pick`");
  for (const [name, field] of Object.entries(spec.fields ?? {})) {
    if (fromField(name) !== undefined) {
      fail(
        `own field "${name}" is named like a field of entity "${from!.name}" — pick it, or name it apart.`,
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
  if (from !== undefined && spec.baseExposures !== false) exposes.base = from;
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
