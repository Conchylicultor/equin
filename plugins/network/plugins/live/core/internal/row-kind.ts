import type { FieldsRecord, InferFieldValue } from "@plugins/fields/core";
import type { LiveRowsCollection } from "./live-collection";
import { fieldDomain } from "./field-domain";
import {
  resolveFieldsSpec,
  type FieldsRow,
  type LiveField,
  type LiveFields,
  type RequireLabel,
} from "./live-fields";

// Rows that are not database data — an app registry's contributions, a
// folder's entries — still have fields declared once (fields declared once,
// phase 2b: `research/2026-10-15-global-fields-declared-once-phase2b.md` §B).
//
// - `rowKind(key, { fields, carry?, id })` is a COLLECTION WITH NO SERVER: the
//   same field spelling as a `liveCollection` over no entity, and the same
//   `key` / `fields` / `rowKeys` a DataView derives a list from (its in-memory
//   origin's `collection` prop takes either). A kind that comes to need server
//   filtering becomes a `liveCollection` of the same fields plus a
//   `serveCollection`, and no list changes.
// - `clientFields(owner, id, { section?, fields })` declares, once, fields
//   whose VALUES are only known in the browser (a git status, a usage summary,
//   a release probe) on an owner — a row kind or a collection. Their values
//   are resolved by the declaring plugin's web half (`ClientFields.Resolve`,
//   `network/live/web`) and every list of the owner gets them, filtered,
//   sorted and grouped IN MEMORY. They are not the owner's fields, so a
//   server query (`useLive(c, { where })`) cannot name one: tsc.

/** A declared kind of in-memory row (see the file comment). */
export interface RowKind<Row, Id extends string = string> {
  readonly kind: "row-kind";
  readonly key: string;
  /** The row field that identifies a row. */
  readonly id: keyof Row & string;
  /** Every declared row field (listed and carried). */
  readonly rowKeys: readonly (keyof Row & string)[];
  /** The listed fields, by id, in declaration order. */
  readonly fields: LiveFields<Id>;
  /** A kind's rows are no entity's and reach none. */
  readonly from: null;
  readonly exposes: null;
  /** Phantom — the row a list of the kind holds (at least these fields). */
  readonly __row?: Row;
}

/** Declare a kind of in-memory row by its fields (see the file comment). */
export function rowKind<
  const OF extends FieldsRecord,
  const CF extends FieldsRecord = Record<never, never>,
>(
  key: string,
  spec: {
    /** The fields every list of the kind shows — each labelled (`RequireLabel`). */
    fields: OF & RequireLabel<OF>;
    /** Fields the row carries that no list shows (its id). */
    carry?: { fields?: CF };
    id: NoInfer<keyof FieldsRow<undefined, never, never, OF, CF> & string>;
  },
): RowKind<FieldsRow<undefined, never, never, OF, CF>, keyof OF & string> {
  const resolved = resolveFieldsSpec(`rowKind:${key}`, {
    fields: spec.fields,
    ...(spec.carry === undefined ? {} : { carry: spec.carry }),
    id: spec.id,
  });
  // Every listed field sorts: a kind's rows are sorted in memory.
  const fields = resolved.fields(Object.keys(spec.fields));
  return Object.freeze({
    kind: "row-kind",
    key,
    id: spec.id as never,
    rowKeys: Object.keys(resolved.row.shape) as never,
    fields: fields as LiveFields<keyof OF & string>,
    from: null,
    exposes: null,
  });
}

/** The row an owner of client fields lists. */
export type ClientFieldsOwnerRow<O> =
  O extends RowKind<infer R>
    ? R
    : O extends LiveRowsCollection<infer R>
      ? R
      : never;

/** What client fields may be declared on: a row kind or a collection. */
export type ClientFieldsOwner =
  RowKind<never, string> | Pick<LiveRowsCollection<unknown>, "key" | "fields">;

/** A field's value as a client field holds it — `null` where it has none for a row. */
export type ClientFieldValue<F> = InferFieldValue<F> | null;

/** Fields whose values the browser resolves, declared once on an owner (see the file comment). */
export interface ClientFields<Row, F extends FieldsRecord = FieldsRecord> {
  readonly kind: "client-fields";
  /** The owner's key (a row kind's, or a collection's). */
  readonly owner: string;
  /** Unique among the owner's client fields — one declaration, one resolver. */
  readonly id: string;
  /** The band the fields are listed under; `null` = with the owner's own fields. */
  readonly section: string | null;
  /** The fields, by id, in declaration order. */
  readonly listed: LiveFields<keyof F & string>;
  /** Phantoms — the owner's row and the declared fields. */
  readonly __row?: Row;
  readonly __fields?: F;
}

/** Declare fields whose values only the browser knows, once, on `owner` (see the file comment). */
export function clientFields<
  const O extends ClientFieldsOwner,
  const F extends FieldsRecord,
>(
  owner: O,
  id: string,
  spec: {
    section?: string;
    fields: F & RequireLabel<F>;
  },
): ClientFields<ClientFieldsOwnerRow<O>, F> {
  const fail = (message: string): never => {
    throw new Error(`clientFields(${owner.key}, "${id}"): ${message}`);
  };
  if (!/^[a-z][a-zA-Z0-9-]*$/.test(id)) fail("the id is not a plain slug.");
  if (spec.section !== undefined && spec.section.trim().length === 0) {
    fail("an empty `section` — omit it to list the fields with the owner's.");
  }
  const listed: Record<string, LiveField> = {};
  for (const [name, field] of Object.entries(spec.fields)) {
    if (Object.hasOwn(owner.fields, name)) {
      fail(`"${name}" is a field of the owner itself — name it apart.`);
    }
    const label = field.meta.label;
    if (label === undefined || label.trim().length === 0) {
      fail(`"${name}" has no label — every client field is listed.`);
    }
    listed[name] = Object.freeze({
      id: name,
      key: name,
      label: label!,
      typeId: field.type.id,
      options: field.meta.optionMeta ?? null,
      primary: false,
      domain: fieldDomain(field),
      sortable: true,
    });
  }
  return Object.freeze({
    kind: "client-fields",
    owner: owner.key,
    id,
    section: spec.section ?? null,
    listed: Object.freeze(listed) as LiveFields<keyof F & string>,
  });
}
