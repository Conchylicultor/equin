import { PLUGIN_MANIFEST_KEY } from "@plugins/framework/plugins/plugin-id/core";
import {
  createFacet,
  type DocFact,
} from "@plugins/plugin-meta/plugins/facets/core";
import { standardPluginDirsFromSnapshot } from "@plugins/framework/plugins/tooling/plugins/collected-dir/plugins/discovery/core";
import {
  type FsSnapshot,
  type SnapshotDirEntry,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { readIfExistsSync } from "@plugins/plugin-meta/plugins/parse-utils/plugins/source-files/core";
import { type StructureFacetData, structureFacetDef } from "../core";
import {
  type AppPath,
  joinAppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// Classifying folders needs the repo's standard-folder set. It is answered from
// the tree build's own in-memory snapshot (`ctx.fs`), which already holds every
// plugin's `core/*.ts`: no disk, and no module-level memo (codegen keeps one
// answer per snapshot). Still synchronous, and still no top-level await — one
// here would suspend this dynamically-imported facet mid-evaluation inside the
// facets ⇄ codegen import cycle, a TDZ crash ("Cannot access 'default' before
// initialization") in loadFacets(). The snapshot is keyed by absolute path, so
// pass the repo root — the root of the checkout being extracted (the plugin's
// dir less its repo-relative one), never this process's own checkout.
function standardDirs(
  fs: FsSnapshot | undefined,
  dir: string,
  relDir: string,
): Set<string> {
  if (fs === undefined) {
    throw new Error(
      "structure facet: extract ran without the tree build's FS snapshot, so it cannot classify folders.",
    );
  }
  if (!dir.endsWith(`/${relDir}`))
    throw new Error(
      `structure facet: plugin dir ${dir} does not end with its repo-relative dir ${relDir}.`,
    );
  return standardPluginDirsFromSnapshot(
    asAppPath(dir.slice(0, dir.length - relDir.length - 1)),
    fs,
  );
}

/**
 * A plugin directory's entries, from the tree build's snapshot (which lists
 * every plugin directory it was handed) — no `readdir`, and git's membership:
 * a folder holding only gitignored files is not one of them.
 */
function readEntries(
  fs: FsSnapshot | undefined,
  dir: string,
): readonly SnapshotDirEntry[] {
  const entries = fs?.dirs.get(dir);
  if (entries === undefined) {
    throw new Error(
      `structure facet: ${dir} is not a directory of the tree build's FS snapshot.`,
    );
  }
  return entries;
}

/**
 * Non-source directories that must never count as plugin folders: dependencies,
 * VCS/dotfiles, and build output (`dist`, `dist.live.<pid>`, `dist.staging.<pid>`).
 * Mirrors the boundary checker's IGNORED_DIRS so we flag genuine structural
 * anomalies, not transient build artifacts.
 */
function isIgnoredDir(name: string): boolean {
  return (
    name === "node_modules" || name.startsWith(".") || name.startsWith("dist")
  );
}

/** Self-declared SPA/CLI bootstrap root (`package.json` `equin.compositionRoot`). */
function readCompositionRoot(dir: AppPath): boolean {
  const src = readIfExistsSync(joinAppPath(dir, "package.json"));
  if (!src) return false;
  try {
    return JSON.parse(src)[PLUGIN_MANIFEST_KEY]?.compositionRoot === true;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return false;
  }
}

export default createFacet<StructureFacetData>({
  def: structureFacetDef,

  extract(ctx) {
    const STD = standardDirs(ctx.fs, ctx.dir, ctx.relDir);
    const entries = readEntries(ctx.fs, ctx.dir);
    const folders = entries
      .filter((e) => e.isDirectory() && !isIgnoredDir(e.name))
      .map((e) => ({ name: e.name, standard: STD.has(e.name) }));
    const looseFiles = entries
      .filter(
        (e) =>
          e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx")),
      )
      .map((e) => e.name);
    return {
      folders,
      looseFiles,
      compositionRoot: readCompositionRoot(ctx.dir),
    };
  },

  renderDoc(data) {
    const facts: DocFact[] = [];
    const nonStandard = data.folders.filter((f) => !f.standard);
    if (nonStandard.length)
      facts.push({
        folder: "structure",
        key: "Non-standard folders",
        values: nonStandard.map((f) => `\`${f.name}/\``),
      });
    if (data.looseFiles.length)
      facts.push({
        folder: "structure",
        key: "Loose top-level files",
        values: data.looseFiles.map((f) => `\`${f}\``),
      });
    if (data.compositionRoot)
      facts.push({
        folder: "structure",
        key: "Composition root",
        values: ["yes"],
      });
    return facts;
  },
});
