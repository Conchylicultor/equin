import type { FieldDef } from "./types";

/**
 * The heading the host's OWN fields get once a schema has sections at all — the
 * dimensions every row has, whatever it is. On the merged run surface those are
 * `Run` / `Kind` / `Outcome` / `Started`; the arms' own columns sit under the
 * arm's name below them.
 */
export const SHARED_FIELD_SECTION = "Common";

/** One titled run of the field schema — the unit every "choose a field" surface
 *  draws a heading for. */
export interface FieldSchemaSection<TRow> {
  /** `FieldDef.section`, or `null` for the host's own un-sectioned fields. */
  id: string | null;
  /** The heading. `SHARED_FIELD_SECTION` for the `null` section. */
  label: string;
  fields: FieldDef<TRow>[];
}

/**
 * Split a merged field schema into its titled sections, in first-appearance
 * order — so the host's own fields come first (they are the schema's `base`)
 * and each contributor's follow in fold order.
 *
 * A schema nobody sectioned yields exactly ONE section, which is what the
 * surfaces test to decide whether headings are worth drawing at all: a single
 * heading over the whole list says nothing.
 */
export function splitFieldSections<TRow>(
  fields: readonly FieldDef<TRow>[],
): FieldSchemaSection<TRow>[] {
  const sections: FieldSchemaSection<TRow>[] = [];
  const byId = new Map<string | null, FieldSchemaSection<TRow>>();
  for (const field of fields) {
    const id = field.section ?? null;
    let section = byId.get(id);
    if (!section) {
      section = { id, label: id ?? SHARED_FIELD_SECTION, fields: [] };
      byId.set(id, section);
      sections.push(section);
    }
    section.fields.push(field);
  }
  return sections;
}

/**
 * The same split, flattened back — a field list reordered so each section's
 * fields are contiguous.
 *
 * The BAND ORDER comes from `schema`, the full field schema, not from `fields`:
 * the list being ordered is usually a subset in some stored order (a view's
 * `properties`, the Properties list with its unlisted fields appended), and
 * taking the order from it would float whichever band that list happens to start
 * with above the host's own — so the same schema would band one way in the
 * Properties list and another in the filter picker. Within a band, the order of
 * `fields` is kept: that one IS the user's.
 *
 * It is what keeps ONE order across the Properties list and the body: the list
 * is drawn band by band, so the columns have to come out band by band too, and
 * both read this. A schema with no sections is returned unchanged.
 */
export function orderFieldsBySection<TRow>(
  fields: readonly FieldDef<TRow>[],
  schema: readonly FieldDef<TRow>[] = fields,
): FieldDef<TRow>[] {
  const bands = splitFieldSections(schema).map((section) => section.id);
  if (bands.length <= 1) return [...fields];

  const grouped = new Map<string | null, FieldDef<TRow>[]>();
  for (const field of fields) {
    const id = field.section ?? null;
    const band = grouped.get(id);
    if (band) band.push(field);
    else grouped.set(id, [field]);
  }

  const ordered: FieldDef<TRow>[] = [];
  for (const id of bands) {
    const band = grouped.get(id);
    if (band) {
      ordered.push(...band);
      grouped.delete(id);
    }
  }
  // A band the schema does not know (a field carrying a section no contributor
  // is registered for). Nothing is dropped — it trails, in encounter order.
  for (const band of grouped.values()) ordered.push(...band);
  return ordered;
}
