import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { findImports } from "@plugins/plugin-meta/plugins/parse-utils/core";

// boundaries:portable-own-barrels' per-file work as a fold kept along the
// directory tree: each `server/` file's deep own-folder imports are a function
// of its bytes and path alone — whether its plugin's server barrel is portable
// is the verdict's question, not the file's — so a pass after an edit reads
// only the edited server files, and a change of portability re-folds nothing.

/** Own folders a deep import may enter: inlined into the server artifact, or not own. */
const OPEN_FOLDERS = new Set(["server", "shared", "plugins", "node_modules"]);

const BARREL_TAILS = new Set(["index", "index.ts", "index.tsx", "index.js"]);

/** Resolve a relative specifier against a repo-relative importer path. */
function resolveRelative(fromFile: string, specifier: string): string {
  const out = fromFile.split("/").slice(0, -1);
  for (const seg of specifier.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/**
 * Where an import of a `server/` file of plugin `pluginDir` lands inside the
 * plugin's own tree, when it enters another own folder below its barrel: the
 * folder and the barrel spelling. Null otherwise (outside the plugin, a bare
 * package, an open folder, the barrel itself).
 */
export function deepOwnTarget(
  pluginDir: string,
  importer: string,
  specifier: string,
): { folder: string; barrel: string } | null {
  let landed: string;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    landed = resolveRelative(importer, specifier);
  } else if (
    specifier.startsWith(`@plugins/${pluginDir.slice("plugins/".length)}/`)
  ) {
    landed = `${pluginDir}/${specifier.slice(`@plugins/${pluginDir.slice("plugins/".length)}/`.length)}`;
  } else return null;
  if (!landed.startsWith(`${pluginDir}/`)) return null;
  const [folder, ...rest] = landed.slice(pluginDir.length + 1).split("/");
  if (folder === undefined || OPEN_FOLDERS.has(folder)) return null;
  if (rest.length === 0 || (rest.length === 1 && BARREL_TAILS.has(rest[0]!)))
    return null;
  const segs = specifier.split("/");
  const tail = segs.slice(segs.length - rest.length);
  const barrel =
    tail.join("/") === rest.join("/")
      ? segs.slice(0, segs.length - rest.length).join("/")
      : `<path to ${folder}/>`;
  return { folder, barrel };
}

/** A `server/` file of a plugin: the plugin's dir, and the file's own path. */
const SERVER_FILE_RE = /^(plugins\/[^/]+(?:\/plugins\/[^/]+)*)\/server\/(.+)$/;

/**
 * The plugin whose `server/` holds `rel` (a sub-plugin's files are its own
 * plugin's business), or null when `rel` is no plugin's server file.
 */
export function serverPluginOf(rel: string): string | null {
  const m = SERVER_FILE_RE.exec(rel);
  if (!m || m[2]!.split("/").includes("plugins")) return null;
  return m[1]!;
}

/** One deep own-folder import of a `server/` file. */
export interface DeepOwnImport {
  /** The importing file. */
  file: string;
  /** Its plugin's dir — whose server barrel decides whether it counts. */
  pluginDir: string;
  message: string;
}

export const deepOwnImportsFold: FileFold<null, DeepOwnImport[]> = {
  url: import.meta.url,
  scan(src, file) {
    const pluginDir = serverPluginOf(file);
    if (pluginDir === null) return [];
    const out: DeepOwnImport[] = [];
    for (const ref of findImports(src)) {
      const target = deepOwnTarget(pluginDir, file, ref.specifier);
      if (target === null) continue;
      out.push({
        file,
        pluginDir,
        message: `${file}: import "${ref.specifier}" enters ${target.folder}/ below its barrel — import "${target.barrel}"`,
      });
    }
    return out;
  },
  combine: (parts) => parts.flat(),
};
