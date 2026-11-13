import { findMarkerCalls } from "@plugins/plugin-meta/plugins/parse-utils/core";
import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import type { CollectedDirDef } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import {
  PLUGIN_FOLDERS,
  type PluginFolder,
} from "@plugins/framework/plugins/plugin-id/core";

// The `defineCollectedDir("<dir>")` markers of one `core/*.ts` file, as a fold
// kept along the directory tree: each candidate's markers are a function of
// its bytes and path alone, so a pass after an edit reads only the edited
// candidates, and an unchanged tree is one record. Its records are keyed by
// this module's closure, so an edit to the marker grammar re-folds every file.

/** One declared collected dir: the declaring file, the folder and its membership. */
export interface CollectedDirMarker {
  rel: string;
  dir: PluginFolder;
  membership: CollectedDirDef["membership"];
}

// First positional string argument of a `defineCollectedDir("<dir>")` call.
const FIRST_STRING_ARG_RE = /^\s*["']([^"']+)["']/;
// The optional second argument, `{ membership: "<m>" }`, spelled literally —
// anything else after the first argument throws (see `membershipOf`).
const MEMBERSHIP_ARG_RE =
  /^\s*,\s*\{\s*membership\s*:\s*["'](composition|checkout)["']\s*,?\s*\}\s*,?\s*$/;

/**
 * The membership the call's text declares. The marker is read by regex, so a
 * second argument this cannot read literally (an identifier, a spread) would
 * otherwise silently mean "composition" — it throws instead, naming the file.
 */
function membershipOf(
  rel: string,
  rest: string,
): CollectedDirDef["membership"] {
  if (rest.trim() === "" || rest.trim() === ",") return "composition";
  const m = MEMBERSHIP_ARG_RE.exec(rest);
  if (!m) {
    throw new Error(
      `${rel}: defineCollectedDir's second argument must be the literal \`{ membership: "composition" | "checkout" }\` — codegen reads the marker by its text. Got: ${rest.trim()}`,
    );
  }
  return m[1] as CollectedDirDef["membership"];
}

const PLUGIN_FOLDER_SET: ReadonlySet<string> = new Set(PLUGIN_FOLDERS);
const isPluginFolder = (name: string): name is PluginFolder =>
  PLUGIN_FOLDER_SET.has(name);

/**
 * The collected dirs `text` (the file `rel`) declares, in call order. A
 * declared name that is not a `PluginFolder` throws naming the file: a
 * collected dir is a plugin folder, and a plugin folder needs its row in the
 * boundary table. The typed marker already makes that a tsc error; this
 * covers the untyped copy.
 */
export function collectedDirMarkersIn(
  rel: string,
  text: string,
): CollectedDirMarker[] {
  // Fast-path: skip files that can't contain the marker. Correctness still
  // comes from `findMarkerCalls`, which ignores comment/string/regex matches.
  if (!text.includes("defineCollectedDir")) return [];
  const out: CollectedDirMarker[] = [];
  for (const call of findMarkerCalls(text, "defineCollectedDir")) {
    const arg = FIRST_STRING_ARG_RE.exec(call.argsText);
    if (!arg) continue;
    const dir = arg[1]!;
    if (!isPluginFolder(dir)) {
      throw new Error(
        `${rel} declares collected dir "${dir}", which is not a plugin folder. ` +
          `Declare it in LEAF_FOLDERS (plugin-id/core) and give it a row in the ` +
          `boundary table (boundaries/core/boundary-config.ts). Known folders: ` +
          `${PLUGIN_FOLDERS.join(", ")}.`,
      );
    }
    out.push({
      rel,
      dir,
      membership: membershipOf(rel, call.argsText.slice(arg[0].length)),
    });
  }
  return out;
}

/** Every candidate's markers, concatenated in path order. */
export const collectedDirsFold: FileFold<null, CollectedDirMarker[]> = {
  url: import.meta.url,
  scan: (src, rel) => collectedDirMarkersIn(rel, src),
  combine: (parts) => parts.flat(),
};
