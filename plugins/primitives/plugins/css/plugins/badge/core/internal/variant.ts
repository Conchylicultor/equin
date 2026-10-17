/**
 * The semantic colour vocabulary of a chip. Declared in `core` rather than
 * beside the `VARIANT_CLASS` map it keys, because a *data* declaration far from
 * any renderer names a variant: a `FieldDef` enum option says how it presents
 * (`data-view/core`), and `core -> web` is not a legal edge. The map itself
 * stays in `web` — the class strings are the renderer's business, the names are
 * everyone's.
 */
export type BadgeVariant =
  | "muted"
  | "primary"
  | "warning"
  | "destructive"
  | "success"
  | "info"
  // A facet the subject LACKS, listed beside the ones it has: no fill, a
  // hairline, faint and struck through — so "has" and "has not" read apart
  // in one row of chips (a workspace's capabilities).
  | "absent";
