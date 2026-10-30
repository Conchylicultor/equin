import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  findImports,
  isPortableServerBarrel,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";

const PORTABLE_OWN_BARRELS = "boundaries:portable-own-barrels";

// A plugin's server barrel, at any nesting depth.
const SERVER_BARREL_RE =
  /^plugins\/[^/]+(?:\/plugins\/[^/]+)*\/server\/index\.ts$/;

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

/**
 * A portable `server/` barrel is browser-built: the browser host's worker loads
 * it as one per-plugin artifact (web-artifacts' `planHostClosure`), and its
 * plugin's other folders as THEIR artifacts — the `core` one every other
 * plugin's code loads too. The builder cannot inline `core/x` into the server
 * artifact (the worker would hold two instances of its module state), so a
 * deep import means the barrel in the browser while `tsc` reads the file. The
 * same rule `runtime-isolation/no-deep-own-folder-import` holds for `web/`,
 * `core/`, `shared/` and `exhibits/`, here for the server files of every
 * plugin claiming `portable: true` (a lint rule cannot see the claim: it lives
 * in another file). The builder throws on the same import as the backstop.
 */
export const portableOwnBarrelsCheck: Check = {
  id: PORTABLE_OWN_BARRELS,
  description:
    "in a plugin whose server barrel declares `portable: true`, `server/` files reach the plugin's other folders only through their barrels (`../core`, never `../core/x`) — the browser host loads each as its barrel artifact",
  async run(ctx): Promise<CheckResult> {
    const repo = await ctx.repo();
    const offenders: string[] = [];
    for (const barrel of repo.all().filter((p) => SERVER_BARREL_RE.test(p))) {
      if (!isPortableServerBarrel((await repo.read(barrel)) ?? "")) continue;
      const serverDir = barrel.slice(0, -"/index.ts".length);
      const pluginDir = serverDir.slice(0, -"/server".length);
      for (const file of repo.under(serverDir)) {
        if (!/\.tsx?$/.test(file) || isTestCodePath(file.split("/"))) continue;
        // A sub-plugin's files are its own plugin's business.
        if (
          file
            .slice(serverDir.length + 1)
            .split("/")
            .includes("plugins")
        )
          continue;
        const src = await repo.read(file);
        if (src === null) continue;
        for (const ref of findImports(src)) {
          const target = deepOwnTarget(pluginDir, file, ref.specifier);
          if (target === null) continue;
          offenders.push(
            `${file}: import "${ref.specifier}" enters ${target.folder}/ below its barrel — import "${target.barrel}"`,
          );
        }
      }
    }
    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${offenders.length} deep own-folder import(s) in portable server code:\n  ${offenders.join("\n  ")}`,
      hint: "Import the folder's barrel, and export what it lacks from its index.ts (or move a server-only helper into the plugin's shared/).",
    };
  },
};
