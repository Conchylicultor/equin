import { idKindField, type IdKind } from "@plugins/ids/core";
import {
  nullable,
  type FieldDef,
  type FieldsRecord,
} from "@plugins/fields/core";
import {
  enumTextField,
  parsedTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { rankField } from "@plugins/fields/plugins/rank/plugins/config/core";
import {
  parseSavedSymbolName,
  SavedSymbolNameSchema,
} from "@plugins/ui/plugins/icons/plugins/saved-names/core";

/**
 * How a parent colours its colourless children. `ramp`: an ordered shade of
 * the parent's colour by rank, light (first) to deep (last) — a price scale.
 */
export const CHILD_COLOR_MODES = ["ramp"] as const;
export type ChildColorMode = (typeof CHILD_COLOR_MODES)[number];

// A nullable icon column: `null` until someone picks one. The inner default is
// never reached — the column is nullable and carries no DB default.
const savedIcon = () =>
  nullable(
    parsedTextField(SavedSymbolNameSchema, {
      default: parseSavedSymbolName("label"),
    }),
  );

/** The base columns every tag tree has, in column order (before the extras). */
function baseFields<I extends FieldDef<string>>(id: I) {
  return {
    id,
    name: textField({ label: "Name", primary: true }),
    /** The parent tag; null at the root. Never a cycle (the move refuses one). */
    parentId: nullable(textField()),
    /** `#rrggbb`; null inherits the nearest ancestor's (`tagColor`). */
    color: nullable(textField()),
    /**
     * How this tag colours its colourless children: `ramp` = an ordered shade
     * of its colour by rank, light → deep (`tagColor`); null = they inherit it.
     */
    childColors: nullable(enumTextField(CHILD_COLOR_MODES)),
    icon: savedIcon(),
    /** Order among siblings: a fractional `Rank` key, minted by the server. */
    rank: rankField(),
  };
}

function timestampFields() {
  return { createdAt: dateField(), updatedAt: dateField() };
}

/** The base field record of a tree whose ids are `P`. */
export type TagTreeBaseFields<P extends string> = ReturnType<
  typeof baseFields<ReturnType<typeof idKindField<P>>>
>;

/** A tree's whole field record: the base, the tree's own extras, the timestamps. */
export type TagTreeFields<
  P extends string,
  X extends FieldsRecord = Record<never, never>,
> = TagTreeBaseFields<P> & X & ReturnType<typeof timestampFields>;

/** The keys every tag tree has — what an extra field may not be named. */
export const TAG_TREE_BASE_KEYS = [
  "id",
  "name",
  "parentId",
  "color",
  "childColors",
  "icon",
  "rank",
  "createdAt",
  "updatedAt",
] as const;
export type TagTreeBaseKey = (typeof TAG_TREE_BASE_KEYS)[number];

/**
 * A tag tree's field record, in column order: the base columns, then the
 * tree's own `extraFields` (Places' Google types and role), then the
 * timestamps. An extra may not reuse a base key (throws).
 */
export function tagTreeFields<
  P extends string,
  X extends FieldsRecord = Record<never, never>,
>(idKind: IdKind<P>, extraFields?: X): TagTreeFields<P, X> {
  const extras = extraFields ?? ({} as X);
  const clash = Object.keys(extras).filter((k) =>
    (TAG_TREE_BASE_KEYS as readonly string[]).includes(k),
  );
  if (clash.length > 0) {
    throw new Error(
      `tagTreeFields(${idKind.prefix}): extra field(s) ${clash.join(", ")} reuse a base tag-tree column.`,
    );
  }
  return {
    ...baseFields(idKindField(idKind)),
    ...extras,
    ...timestampFields(),
  };
}

/**
 * The base record of ANY tree — its id a plain stored string rather than one
 * kind's — from which the shared `TagRowSchema` is derived.
 */
export function anyTagTreeBaseFields() {
  return { ...baseFields(textField()), ...timestampFields() };
}
