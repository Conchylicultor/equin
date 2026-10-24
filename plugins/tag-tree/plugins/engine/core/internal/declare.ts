import type { FieldDef, FieldsRecord } from "@plugins/fields/core";
import type { IdKind } from "@plugins/ids/core";
import {
  entityRef,
  type EntityRef,
} from "@plugins/infra/plugins/entities/core";
import type { LiveAllCollection } from "@plugins/network/plugins/live/core";
import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import {
  TAG_TREE_BASE_KEYS,
  tagTreeFields,
  type ChildColorMode,
  type TagTreeBaseKey,
  type TagTreeFields,
} from "./fields";
import type { TagRow } from "./schema";

/**
 * The field record every tag tree's carries, loosely typed: what the generic
 * engine (the server's table and handlers, the picker) reads off any tree.
 */
export interface AnyTagTreeFields extends FieldsRecord {
  id: FieldDef<string>;
  name: FieldDef<string>;
  parentId: FieldDef<string | null>;
  color: FieldDef<string | null>;
  childColors: FieldDef<ChildColorMode | null>;
  icon: FieldDef<SavedSymbolName | null>;
  rank: FieldDef<string>;
  createdAt: FieldDef<Date>;
  updatedAt: FieldDef<Date>;
}

/**
 * A tag tree's entity ref: the ordinary `EntityRef` (its table name and field
 * record), plus the id kind its tags are minted with — so the server mints a
 * new tag's id from the tree alone.
 */
export type TagTreeEntityRef<
  N extends string = string,
  F extends AnyTagTreeFields = AnyTagTreeFields,
> = EntityRef<N, F> & { readonly idKind: MintableIdKind };

/** An id kind the server can mint from nothing (a `hash` kind needs a digest). */
type MintableIdKind = IdKind<string, "stamped" | "uuid">;

/** Any tree's entity ref — what the generic engine takes. */
export type AnyTagTreeEntityRef = TagTreeEntityRef<string, AnyTagTreeFields>;

/** The tree's own extra field keys (Places' `googleTypes`, `role`). */
export type ExtraKeyOf<R extends AnyTagTreeEntityRef> = Exclude<
  keyof R["fields"] & string,
  TagTreeBaseKey
>;

/**
 * The entity ref of a tag tree stored in table `table`, its ids of `idKind`,
 * with the tree's own `extraFields` between the base columns and the
 * timestamps (`tagTreeFields`). The server builds the table from it
 * (`defineTagTreeTable`); a `liveCollection` reads it, its spec written out as
 * an inline literal (the resource scanners read no call): pick `name` plus
 * the extras a list shows, carry every other field, id `id`, and `all` in
 * `rank` order (`unbounded` — a tree is read whole).
 */
export function tagTreeEntityRef<
  const N extends string,
  P extends string,
  X extends FieldsRecord = Record<never, never>,
>(
  table: N,
  spec: { idKind: IdKind<P, "stamped" | "uuid">; extraFields?: X },
): TagTreeEntityRef<N, TagTreeFields<P, X>> {
  const ref = entityRef(table, tagTreeFields(spec.idKind, spec.extraFields));
  return Object.freeze({ ...ref, idKind: spec.idKind as MintableIdKind });
}

/** One declared tag tree: its route id, entity and live collection. */
export interface TagTree<Row extends TagRow = TagRow> {
  /** The `:tree` route param: `[a-z][a-z0-9-]*`, unique (a duplicate throws at first resolution). */
  readonly id: string;
  readonly entity: AnyTagTreeEntityRef;
  readonly collection: LiveAllCollection<Row>;
}

const TREE_ID_RE = /^[a-z][a-z0-9-]*$/;

/** Declare a tag tree (core, browser-safe): the handle the server serves and the picker reads. */
export function defineTagTree<Row extends TagRow>(spec: {
  id: string;
  entity: AnyTagTreeEntityRef;
  collection: LiveAllCollection<Row>;
}): TagTree<Row> {
  if (!TREE_ID_RE.test(spec.id)) {
    throw new Error(
      `defineTagTree("${spec.id}"): a tree id is lower kebab case ([a-z][a-z0-9-]*) — it is a URL segment.`,
    );
  }
  for (const key of TAG_TREE_BASE_KEYS) {
    if (!(key in spec.entity.fields)) {
      throw new Error(
        `defineTagTree("${spec.id}"): entity ${spec.entity.name} has no "${key}" field — build its ref with tagTreeEntityRef.`,
      );
    }
  }
  return Object.freeze({ ...spec });
}
