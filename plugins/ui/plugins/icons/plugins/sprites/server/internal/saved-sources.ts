import type { RoutedSource } from "@plugins/infra/plugins/query-resource/server";
import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";

/**
 * A place that stores user-picked icons, and so wants them drawable at first
 * paint. The resident saved-icon sprites draw every name any source reports.
 */
export interface SavedIconSource {
  /** Unique across sources (diagnostics, duplicate detection). */
  readonly id: string;
  /**
   * The saved names this source holds right now. A DB-backed source reads
   * through the `db` pool and lists those tables in `tables`: the served value
   * declares them as its reads and recomputes when they change.
   */
  readonly tables: readonly RoutedSource[];
  names(): Promise<readonly SavedSymbolName[]> | readonly SavedSymbolName[];
  /**
   * For a source whose truth is NOT in Postgres (a config): start watching it,
   * calling `onChange` whenever its names may have changed; return the stop.
   * Omitted for a DB-backed source.
   */
  watch?(onChange: () => void): () => void;
}

const sources = new Map<string, SavedIconSource>();

/**
 * Register a saved-icon source (at module eval, from the plugin that owns the
 * store). The sprites plugin knows no source by name; a second source with one
 * id throws.
 */
export function defineSavedIconSource(
  source: SavedIconSource,
): SavedIconSource {
  if (sources.has(source.id)) {
    throw new Error(
      `[icons] saved-icon source "${source.id}" is defined twice`,
    );
  }
  sources.set(source.id, source);
  return source;
}

export function savedIconSources(): readonly SavedIconSource[] {
  return [...sources.values()];
}
