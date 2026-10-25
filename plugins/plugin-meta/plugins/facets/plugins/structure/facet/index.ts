import { PLUGIN_MANIFEST_KEY } from "@plugins/framework/plugins/plugin-id/core";
import { readdirSync, type Dirent } from "fs";
import { dirname, join } from "path";
import {
  createFacet,
  type DocFact,
} from "@plugins/plugin-meta/plugins/facets/core";
import { standardPluginDirsFromSnapshot } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/core";
import {
  readIfExists,
  type FsSnapshot,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { type StructureFacetData, structureFacetDef } from "../core";

// Classifying folders needs the repo's standard-folder set. It is answered from
// the tree build's own in-memory snapshot (`ctx.fs`), which already holds every
// plugin's `core/*.ts`: no disk, and no module-level memo (codegen keeps one
// answer per snapshot). Still synchronous, and still no top-level await — one
// here would suspend this dynamically-imported facet mid-evaluation inside the
// facets ⇄ codegen import cycle, a TDZ crash ("Cannot access 'default' before
// initialization") in loadFacets(). The snapshot is keyed by absolute path, so
// pass the repo root its `plugins/` sits under.
function standardDirs(fs: FsSnapshot | undefined): Set<string> {
  if (fs === undefined) {
    throw new Error(
      "structure facet: extract ran without the tree build's FS snapshot, so it cannot classify folders.",
    );
  }
  return standardPluginDirsFromSnapshot(dirname(PLUGINS_DIR), fs);
}

/** Read a directory's entries, yielding [] if it is unreadable. */
function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code == null) throw err;
    return [];
  }
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
function readCompositionRoot(dir: string): boolean {
  const src = readIfExists(join(dir, "package.json"));
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
    const STD = standardDirs(ctx.fs);
    const entries = readEntries(ctx.dir);
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
