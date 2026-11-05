import type { ResourcePreload } from "@plugins/network/plugins/live/plugins/live-state/core";

/**
 * A collection whose boot id set names a `:rows` boot tuple
 * (`ServeCollectionOptions.preloadRows`): one declared `all` — its whole
 * ordered set is one param-less tuple the client holds at first render when
 * preloaded (a serve-time throw when it is not).
 */
export interface PreloadRowsSource {
  key: string;
  /** The set's row fields — what `PreloadRows.field` may name. */
  rowKeys: readonly string[];
  all: {
    key: string;
    preload?: ResourcePreload;
    /** The set's row key — its id, as every reader keys its rows. */
    keyed: { keyOf: (row: unknown) => string };
  };
}

/** `ServeCollectionOptions.preloadRows`: where the `:rows` boot tuple's ids come from. */
export interface PreloadRows {
  idsOf: PreloadRowsSource;
  /**
   * A field of `idsOf`'s rows holding an id of THIS collection — the tuple is
   * its distinct values (a row whose value is not a string is a loud loader
   * error). Absent: `idsOf`'s own row ids.
   */
  field?: string;
}
