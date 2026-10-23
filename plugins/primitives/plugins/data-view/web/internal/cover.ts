import type { CoverContent, FieldDef } from "../../core";

/** A surface's resolved cover: whether its rows have covers at all, and each
 *  row's. */
export interface ResolvedCover<TRow> {
  /** The surface is covered: every row gets a frame (a coverless row a blank
   *  one), so every card stays the same size. */
  hasCovers: boolean;
  /** This row's cover, or `null` (a blank frame on a covered surface). */
  coverOf: (row: TRow) => CoverContent | null;
  /** The field the cover is drawn from, when it is field-driven — never also a
   *  card token. */
  field: FieldDef<TRow> | undefined;
}

const NO_COVER = (): null => null;

/** The cover field of a schema: the one declaring `cover: true`, else the first
 *  `media` field. */
export function pickCoverField<TRow>(
  fields: readonly FieldDef<TRow>[],
): FieldDef<TRow> | undefined {
  return (
    fields.find((f) => f.cover === true) ??
    fields.find((f) => f.type === "media")
  );
}

/**
 * THE cover precedence, one place for every view (gallery card, list
 * thumbnail): the surface's `DataViewProps.cover` accessor → the field
 * declaring `FieldDef.cover` → the first `media` field. Pass the view's
 * VISIBLE fields (`resolveBodyFields`), so hiding the cover field in
 * Properties hides the covers.
 *
 * A field-driven cover is an image when the field's value is a non-empty
 * string (its URL), else the field's own `cell` as a node, else none.
 */
export function resolveCover<TRow>(
  fields: readonly FieldDef<TRow>[],
  cover: ((row: TRow) => CoverContent | null) | undefined,
): ResolvedCover<TRow> {
  if (cover) return { hasCovers: true, coverOf: cover, field: undefined };
  const field = pickCoverField(fields);
  if (!field) return { hasCovers: false, coverOf: NO_COVER, field: undefined };
  return {
    hasCovers: true,
    field,
    coverOf: (row) => {
      const raw = field.value?.(row);
      if (typeof raw === "string" && raw.length > 0) {
        return { kind: "image", src: raw };
      }
      return field.cell ? { kind: "node", node: field.cell(row) } : null;
    },
  };
}
