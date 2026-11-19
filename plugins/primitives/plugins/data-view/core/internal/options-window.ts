import type { Filter } from "@plugins/network/plugins/live/plugins/filter/core";
import type { LiveCollection } from "@plugins/network/plugins/live/core";
import type { LiveSearchableColumn } from "./live-data-source";
import type { FieldOption } from "./types";

/**
 * An OPEN option set — a column whose values grow with the data (a site's
 * visited pages), which no read may hold whole — declared as data: the window
 * collection whose rows are the values, the scope ANDed into every read, the
 * text column the picker's search runs `contains` on, and each row's option.
 * The filter picker reads it itself (one `useLive` window, only while open):
 * the top of the set in the collection's default order, or the rows whose
 * search column contains what was typed — the server searches, never the
 * picker over a partial list. Built by {@link optionsWindow}, which types the
 * search column and the row against the collection.
 */
export interface FieldOptionsWindow {
  readonly collection: LiveCollection<unknown, unknown, string>;
  readonly where: Filter;
  readonly search: string;
  readonly option: (row: unknown) => FieldOption;
}

/** A field's open option set, read as a searched window of `collection` (see {@link FieldOptionsWindow}). */
export function optionsWindow<Row, F, S extends string>(
  collection: LiveCollection<Row, F, S>,
  spec: {
    /** The scope every read is ANDed with (the site the options are of). */
    where: Filter;
    /** The text column the search box matches (`contains`). */
    search: LiveSearchableColumn<F>;
    /** A row as the option the picker draws. */
    option: (row: Row) => FieldOption;
  },
): FieldOptionsWindow {
  return {
    collection: collection as unknown as LiveCollection<
      unknown,
      unknown,
      string
    >,
    where: spec.where,
    search: spec.search,
    option: spec.option as (row: unknown) => FieldOption,
  };
}
