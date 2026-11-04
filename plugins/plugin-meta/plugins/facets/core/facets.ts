import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { SlotNaming } from "@plugins/framework/plugins/slot-declaration/core";
import type { FsSnapshot } from "@plugins/plugin-meta/plugins/parse-utils/core";

export interface FacetDef<T> {
  id: string;
  _phantom?: T;
}

/**
 * What one facet's `extract` of one plugin reads: that plugin's own files, and
 * nothing else. Its result is a PLUGIN RECORD (`plugin-meta/plugin-records`),
 * stored under the hash of exactly those files and the facet's own code, and
 * shared by every worktree — so `extract` must be a pure function of them. A
 * read outside the plugin's files throws while a record is being made (the
 * snapshot is strict), and so does a module-level variable that would carry a
 * plugin's data into another's extraction: whatever needs more than one plugin
 * is `relate`'s job.
 */
export interface ExtractContext {
  dir: AppPath;
  /** The plugin's directory, relative to the repo root — what a record may store (never `dir`). */
  relDir: string;
  /**
   * The plugin this extraction describes, as its dotted id.
   *
   * A facet describing SOURCE (what a plugin declares) can need a slot's id
   * without the runtime having stamped one — a disabled plugin's barrel is still
   * read here, and its slots are never declared. `${pluginId}.${key}` is the id
   * either way, so the facet derives it rather than depending on a stamp.
   */
  pluginId: string;
  // The plugin's files, read once, in memory. The parse-utils `readIfExists` /
  // `walkFiles` helpers read from it (wired ambiently by buildPluginTree's
  // extract loop), so facet bodies need no change; the structure facet reads it
  // through codegen's standardPluginDirsFromSnapshot.
  fs?: FsSnapshot;
}

/**
 * What a facet's `enrich` adds to its record: the plugin's barrels as the build
 * evaluated them, PAIRED with the naming of the slots their contributions
 * target.
 *
 * ONE FIELD, NOT TWO, and that is the whole point — do not flatten it back into
 * `modules?` beside `naming?`. Importing a barrel is what brings a plugin's
 * `contributions` into existence; running a declaration pass is what gives the
 * slots those contributions target their names. A reader holding the first
 * without the second gets an answer that is smaller than the truth and shaped
 * exactly like a correct one: every id reads as absent, so a whole plugin's
 * contributions silently vanish. That is not hypothetical — it is how a
 * `docs/plugins-details.md` missing reorder's entire `Contributes:` block got
 * committed, and how it made `main` un-pushable four commits later. Pairing the
 * two makes the state unspellable.
 *
 * The modules are the build's evaluated records (`plugin-records`), revived: a
 * contribution's component is a function with its name, its slot a stand-in the
 * naming resolves. Never cached per plugin — the naming is the whole tree's.
 */
export interface EnrichContext {
  dir: AppPath;
  pluginId: string;
  imported: {
    modules: {
      mod: Record<string, unknown>;
      runtime: "web" | "server" | "machine" | "central";
    }[];
    naming: SlotNaming;
  };
}

/**
 * A per-plugin extraction too costly to run plugin by plugin (cross-refs' token
 * scan batches every plugin into one Tailwind pass). It runs over the plugins
 * whose record missed only, and writes into their extracted data, which is then
 * stored — so `inputs` must name every repo file besides the plugins' own that
 * its result reads (they are part of the key).
 */
export interface ExtractBatch<T> {
  /** Repo-relative files the batch reads besides each plugin's own. */
  inputs: readonly string[];
  run(ctx: {
    root: AppPath;
    fs: FsSnapshot;
    plugins: readonly { dir: AppPath; data: T }[];
  }): Promise<void>;
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
  extractBatch?: ExtractBatch<unknown>;
  enrich?: (data: unknown, ctx: EnrichContext) => unknown;
  relate?: (ctx: unknown) => void;
  renderDoc: (data: unknown, ctx: RenderDocContext) => DocFact[];
}

export function defineFacet<T>(id: string): FacetDef<T> {
  return { id };
}

export function createFacet<T>(impl: {
  def: FacetDef<T>;
  extract: (ctx: ExtractContext) => T;
  extractBatch?: ExtractBatch<T>;
  /**
   * The barrel-evaluated part of the facet, from the build's evaluated records
   * (see {@link EnrichContext}): returns the enriched data. Runs on every
   * enriched tree, after the records are read and before `relate`.
   */
  enrich?: (data: T, ctx: EnrichContext) => T;
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
