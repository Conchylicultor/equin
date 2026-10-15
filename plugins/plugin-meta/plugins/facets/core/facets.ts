import type { SlotNaming } from "@plugins/framework/plugins/slot-declaration/core";
import type { FsSnapshot } from "@plugins/plugin-meta/plugins/parse-utils/core";

export interface FacetDef<T> {
  id: string;
  _phantom?: T;
}

export interface ExtractContext {
  dir: string;
  /**
   * The plugin this extraction describes, as its dotted id.
   *
   * A facet describing SOURCE (what a plugin declares) can need a slot's id
   * without the runtime having stamped one — a disabled plugin's barrel is still
   * read here, and its slots are never declared. `${pluginId}.${key}` is the id
   * either way, so the facet derives it rather than depending on a stamp.
   */
  pluginId: string;
  /**
   * The barrels imported for this plugin, PAIRED with the naming the declaration
   * pass over those same barrels settled. Populated by `buildPluginTree` unless
   * `skipBarrelImport` is set; absent for facets that only need static files.
   *
   * ONE FIELD, NOT TWO, and that is the whole point — do not flatten it back into
   * `modules?` beside `naming?`. Importing a barrel is what brings a plugin's
   * `contributions` into existence; running a declaration pass is what gives the
   * slots those contributions target their names. A reader holding the first
   * without the second gets an answer that is smaller than the truth and shaped
   * exactly like a correct one: every id reads as absent, so a whole plugin's
   * contributions silently vanish. That is not hypothetical — it is how a
   * `docs/plugins-details.md` missing reorder's entire `Contributes:` block got
   * committed, and how it made `main` un-pushable four commits later. A runtime
   * assert used to catch it here; pairing the two makes the state unspellable
   * instead, so there is nothing left to assert.
   */
  imported?: {
    modules: {
      mod: Record<string, unknown>;
      runtime: "web" | "server" | "central";
    }[];
    naming: SlotNaming;
  };
  // Build-scoped, read-once in-memory FS snapshot in effect for this extraction.
  // When present, the parse-utils `readIfExists` / `walkFiles` helpers read from
  // it instead of disk (wired ambiently by buildPluginTree's extract loop), so
  // facet bodies need no change. Absent for build-time callers that scan disk
  // directly. Facets read files via the parse-utils helpers, not this field
  // (the structure facet reads it through codegen's
  // standardPluginDirsFromSnapshot).
  fs?: FsSnapshot;
}

interface DocFactBase {
  folder: string;
  key: string;
}

/** One group of a {@link DocFact} whose values the doc may summarize. */
export interface DocFactGroup {
  /** What the group's values share, as the summary names it (`` `apps` ``, a slot). */
  label: string;
  values: string[];
}

/**
 * One fact a facet documents about a plugin: a key and its values, one per line.
 *
 * A facet whose list can grow without bound (importers, contributions) hands
 * its values GROUPED, with the noun they count. The doc then lists them in full
 * while short, and past its budget prints one count per group instead, the full
 * list going to a separate on-demand file. A flat fact (exports, routes) is
 * always printed in full: the facet is the one that knows what a value is, so
 * only it can say how the list summarizes — and whether it may.
 */
export type DocFact =
  | (DocFactBase & { values: string[] })
  | (DocFactBase & { noun: string; groups: DocFactGroup[] });

/** Every value of a fact, in order — a grouped fact's groups concatenated. */
export function docFactValues(fact: DocFact): string[] {
  return "groups" in fact ? fact.groups.flatMap((g) => g.values) : fact.values;
}

export interface RenderDocContext {
  root: string;
}

export interface Facet {
  def: FacetDef<unknown>;
  extract: (ctx: ExtractContext) => unknown;
  prepareRelate?: (ctx: unknown) => Promise<void>;
  relate?: (ctx: unknown) => void;
  renderDoc: (data: unknown, ctx: RenderDocContext) => DocFact[];
}

export function defineFacet<T>(id: string): FacetDef<T> {
  return { id };
}

export function createFacet<T>(impl: {
  def: FacetDef<T>;
  extract: (ctx: ExtractContext) => T;
  /**
   * Async work over the whole extracted tree, before any facet's `relate` —
   * for a pass too heavy to run in one synchronous block (it can yield) or that
   * needs an async API. Same `{ tree }` context as `relate`, plus the build's
   * `fs` snapshot, which a sync stretch reads under `runWithFsSnapshot(fs, …)`
   * (the ambient snapshot does not survive an `await`).
   */
  prepareRelate?: (ctx: unknown) => Promise<void>;
  relate?: (ctx: unknown) => void;
  renderDoc: (data: T, ctx: RenderDocContext) => DocFact[];
}): Facet {
  return impl as Facet;
}

export function getFacet<T>(
  node: { facets: Record<string, unknown> },
  def: FacetDef<T>,
): T | undefined {
  return node.facets[def.id] as T | undefined;
}

export function setFacet<T>(
  node: { facets: Record<string, unknown> },
  def: FacetDef<T>,
  data: T,
): void {
  node.facets[def.id] = data;
}
