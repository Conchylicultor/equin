import {
  orderFieldsBySection,
  type FieldDef,
  type PropertyEntry,
} from "../../core";

/**
 * Resolve the BODY field list for a view from the full schema + the view's
 * per-instance `properties` list. The single shared seam every view uses to
 * decide which fields (and in what order) render in its body — sort/filter/search
 * keep operating on the full `fields`.
 *
 * - `null`/`undefined` (unconfigured) → the schema's own default body set: every
 *   field in schema order EXCEPT those declaring `visible: false` (a dimension
 *   that is not printed). Sort / filter / search are unaffected — every view
 *   runs its section pipeline over the full `fields` and calls this only for the
 *   body.
 * - explicit array → the entries not marked `hidden`, in stored order, resolved
 *   via a byId map; ids the schema no longer carries (e.g. a removed custom
 *   column) are dropped. A schema field the array does not list is hidden — a
 *   field added after the view was customized arrives hidden.
 *
 * Either way the result comes out **band by band** when the schema has sections
 * (`orderFieldsBySection`): the Properties list is drawn as one band per source,
 * and the list IS the body order — so a column cannot sit between two bands in
 * the table while the list that ordered it shows it inside one. Unsectioned
 * schemas keep their order untouched.
 */
export function resolveBodyFields<TRow>(
  fields: FieldDef<TRow>[],
  properties: readonly PropertyEntry[] | null | undefined,
): FieldDef<TRow>[] {
  if (properties == null) {
    // Already band-ordered: the schema is the host's own fields followed by each
    // contributor's, which is what `orderFieldsBySection` produces.
    return fields.filter((f) => f.visible !== false);
  }
  const byId = new Map(fields.map((f) => [f.id, f]));
  return orderFieldsBySection(
    properties
      .filter((p) => !p.hidden)
      .map((p) => byId.get(p.id))
      .filter((f): f is FieldDef<TRow> => f != null),
    // Band order from the SCHEMA — a stored array starting with an arm's column
    // must not float that arm's band above the host's own.
    fields,
  );
}
