import { z } from "zod";
import {
  declaredDefault,
  defineDefaultlessField,
  type DefaultlessFieldDef,
  type FieldDef,
  type ExactOptions,
  type FieldMarks,
  type FieldMeta,
  type FieldType,
  pickMeta,
} from "@plugins/fields/core";
import { rankFieldType } from "@plugins/fields/plugins/rank/core";
import { type Rank, RankSchema } from "@plugins/primitives/plugins/rank/core";

export interface RankFieldDef extends FieldDef<string> {
  readonly type: typeof rankFieldType;
}

// Builds a `rank` field record entry. The schema is a bare `z.string()` (the raw
// fractional-indexing key) — the `Rank` value-object transform stays a
// wire-schema concern, so the column's `$inferSelect` type remains `string`.
// The column is non-nullable with no DB default (a rank is always computed on
// insert via `nextRankIn` / `nextRankUnder` / `Rank.between`).
// The options mark the field (`FieldMarks`: a declared `default`, a `label`,
// `filterable: false`).
export function rankField<
  const O extends FieldMeta & { default?: string } = Record<never, never>,
>(
  opts?: ExactOptions<O, FieldMeta & { default?: string }>,
): RankFieldDef & FieldMarks<O> {
  return Object.freeze({
    type: rankFieldType,
    schema: z.string(),
    defaultValue: opts?.default ?? "",
    ...declaredDefault(opts),
    meta: pickMeta(opts),
  }) as RankFieldDef & FieldMarks<O>;
}

export interface RankValueFieldDef extends DefaultlessFieldDef<Rank> {
  readonly type: FieldType<Rank>;
}

// The WIRE form of a rank column: the same `rank` type, its value the `Rank`
// value object (`RankSchema`, which also accepts the raw key) — what a live
// collection declared by fields carries for a row's rank
// (`liveCollection({ carry: { fields: { rank: rankValueField() } } })`), so
// its rows sort and move by `Rank` as the hand wire schemas did. Never a
// column of an entity record: the column's value stays the raw `string`
// (`rankField`), the transform a wire concern.
//
// DEFAULTLESS: a row's rank is always on the wire (the column is NOT NULL),
// so a missing one is a loud parse failure, never a backfilled empty rank —
// and the row schema holds no default that is not one JSON value (a `Rank`
// object), which would leave every collection carrying a rank with no
// point definition (the epoch handoff never inherits its `:rows`).
export function rankValueField(): RankValueFieldDef {
  return defineDefaultlessField({
    type: rankFieldType as unknown as FieldType<Rank>,
    schema: RankSchema,
    meta: pickMeta(undefined),
  }) as RankValueFieldDef;
}
