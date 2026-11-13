import type { Check } from "@plugins/framework/plugins/tooling/core";
import { defineFoldCheck } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
import { serverPortabilityOf } from "../core/portability";
import {
  deepOwnImportsFold,
  serverPluginOf,
} from "./portable-own-barrels.scan";

const PORTABLE_OWN_BARRELS = "boundaries:portable-own-barrels";

/**
 * A portable `server/` barrel is browser-built: the browser host's worker loads
 * it as one per-plugin artifact (web-artifacts' `planHostClosure`), and its
 * plugin's other folders as THEIR artifacts — the `core` one every other
 * plugin's code loads too. The builder cannot inline `core/x` into the server
 * artifact (the worker would hold two instances of its module state), so a
 * deep import means the barrel in the browser while `tsc` reads the file. The
 * same rule `runtime-isolation/no-deep-own-folder-import` holds for `web/`,
 * `core/`, `shared/` and `exhibits/`, here for the server files of every
 * plugin whose server barrel is portable (`serverPortabilityOf` — a fact of
 * the whole closure, which a per-file lint rule cannot see). The builder
 * throws on the same import as the backstop.
 */
export const portableOwnBarrelsCheck: Check = defineFoldCheck({
  id: PORTABLE_OWN_BARRELS,
  description:
    "in a plugin whose server barrel is portable (derived from its closure), `server/` files reach the plugin's other folders only through their barrels (`../core`, never `../core/x`) — the browser host loads each as its barrel artifact",
  // A fold check: each server file's deep own-folder imports are its record
  // (./portable-own-barrels.scan.ts), whatever its plugin's portability; the
  // verdict keeps those of the plugins whose server barrel is portable.
  context: () => null,
  files: (repo) =>
    repo
      .under("plugins")
      .filter(
        (f) =>
          /\.tsx?$/.test(f) &&
          !isTestCodePath(f.split("/")) &&
          serverPluginOf(f) !== null,
      ),
  facts: async (ctx) => serverPortabilityOf(await ctx.repo()),
  fold: deepOwnImportsFold,
  verdict(found, { facts: portability }) {
    const portable = new Set(
      portability.barrels.filter((b) => portability.isPortable(b)),
    );
    const offenders = found
      .filter((d) => portable.has(`${d.pluginDir}/server/index.ts`))
      .map((d) => d.message)
      .sort();
    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${offenders.length} deep own-folder import(s) in portable server code:\n  ${offenders.join("\n  ")}`,
      hint: "Import the folder's barrel, and export what it lacks from its index.ts (or move a server-only helper into the plugin's shared/).",
    };
  },
});
