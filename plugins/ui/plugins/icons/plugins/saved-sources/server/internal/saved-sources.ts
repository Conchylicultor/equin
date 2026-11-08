import type { RoutedSource } from "@plugins/network/plugins/live/plugins/query-resource/server";
import type { ServedAllCollection } from "@plugins/network/plugins/live/server";
import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import { defineSourceSet } from "@plugins/packages/plugins/source-digest/core";

/**
 * A place that stores user-picked icons, and so wants them drawable at first
 * paint. The resident saved-icon sprites draw every name any source reports.
 * Three kinds, by where the names live and how a change reaches the sprites:
 *
 * - {@link FollowedSavedIconSource} — rows of a served scoped collection: the
 *   sprites follow that one scope, so a write reaches them only when it
 *   touches a row of it and a column the collection reads.
 * - {@link TableSavedIconSource} — whole tables: any write to any row of them
 *   recomputes the sprites.
 * - {@link WatchedSavedIconSource} — a store outside Postgres (a config),
 *   watched.
 */
export type SavedIconSource =
  FollowedSavedIconSource | TableSavedIconSource | WatchedSavedIconSource;

interface SavedIconSourceBase {
  /** Unique across sources (diagnostics, duplicate detection, the follow's name). */
  readonly id: string;
}

/**
 * The names live in the rows of ONE scope of a served scoped `all`
 * collection (`all: { by }`): `collection` followed at `where`, each row's
 * names read by `namesOf`. Preferred for a DB store — the follow keeps the
 * collection's column gate and scope match.
 */
export interface FollowedSavedIconSource<
  Row = unknown,
  B extends string = string,
> extends SavedIconSourceBase {
  readonly kind: "followed";
  readonly collection: ServedAllCollection<Row, B>;
  readonly where: { readonly [K in B]: string };
  namesOf(rows: readonly Row[]): readonly SavedSymbolName[];
}

/**
 * The names a query over whole tables reads, through the `db` pool: the
 * served value declares `tables` as its reads, so a write to ANY row of them
 * recomputes it.
 */
export interface TableSavedIconSource extends SavedIconSourceBase {
  readonly kind: "tables";
  readonly tables: readonly RoutedSource[];
  names(): Promise<readonly SavedSymbolName[]>;
}

/**
 * The names live outside Postgres (a config): `watch` starts watching it,
 * calling `onChange` whenever its names may have changed, and returns the
 * stop.
 */
export interface WatchedSavedIconSource extends SavedIconSourceBase {
  readonly kind: "watched";
  names(): readonly SavedSymbolName[];
  watch(onChange: () => void): () => void;
}

const sources = new Map<string, SavedIconSource>();

/**
 * The code of every registered source (each `defineSavedIconSource` caller's
 * module): what the persisted saved-icon sprites are computed by besides their
 * own module, which reaches the sources through this registry, not by import.
 */
export const savedIconSourcesCode = defineSourceSet(
  "the saved-icon sources' code (the names the persisted sprites draw)",
);

/**
 * Register a saved-icon source (at module eval, from the plugin that owns the
 * store), with `code: import.meta` — the module holding its `names()`, so the
 * persisted sprites are recomputed when it changes. The sprites plugin knows
 * no source by name; a second source with one id throws.
 */
export function defineSavedIconSource<Row, B extends string>(
  source: FollowedSavedIconSource<Row, B> & { code: ImportMeta },
): FollowedSavedIconSource<Row, B>;
export function defineSavedIconSource(
  source: (TableSavedIconSource | WatchedSavedIconSource) & {
    code: ImportMeta;
  },
): SavedIconSource;
export function defineSavedIconSource({
  code,
  ...source
}: SavedIconSource & { code: ImportMeta }): SavedIconSource {
  if (sources.has(source.id)) {
    throw new Error(
      `[icons] saved-icon source "${source.id}" is defined twice`,
    );
  }
  savedIconSourcesCode.include(code);
  sources.set(source.id, source as SavedIconSource);
  return source;
}

export function savedIconSources(): readonly SavedIconSource[] {
  return [...sources.values()];
}
