import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { foldRepoFiles } from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  assemblePluginTree,
  findAllPluginDirs,
  PLUGIN_KEY_FILES,
  pluginFieldsFrom,
  type PluginFields,
  type PluginTree,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { keyFactsFold } from "./key-facts.scan";

/**
 * The structure tree under `pluginsRoot` (the repo's `plugins/` folder), the
 * same tree `buildPluginTree` reads — with each key file's facts a plugin
 * record (`keyFactsFold`), so a pass parses only the key files no earlier pass
 * folded: an unchanged tree is one fold lookup and the in-memory link, an edit
 * re-parses the edited barrels alone. Membership is the set's
 * (`repo.under` / `repo.has`), never a listing.
 *
 * Build tooling (it reads the process's record store); a backend keeps its
 * tree with `createStructureIndex` instead.
 */
export async function buildRecordedPluginTree(
  pluginsRoot: AppPath,
  { repo }: { repo: RepoFiles },
): Promise<PluginTree> {
  // The key-file fold reads the repo's `plugins/` folder: its records are
  // keyed by repo-relative paths under it.
  const rootRel = "plugins";
  if (pluginsRoot !== joinAppPath(repo.root, rootRel)) {
    throw new Error(
      `buildRecordedPluginTree(${pluginsRoot}): the plugins root must be the repo set's plugins/ folder (${repo.root}).`,
    );
  }
  const dirs = findAllPluginDirs(pluginsRoot, repo);
  const fields = await recordedPluginFields(repo, dirs);
  const plugins = dirs.map((dir) => [dir, fields.get(dir)!] as const);
  return { ...assemblePluginTree(pluginsRoot, plugins), repo, facets: [] };
}

/**
 * The fields of each of `plugins` (paths under the repo's `plugins/`
 * folder), from their key files' facts as folded records — a plugin whose key
 * files no earlier process folded is the only one parsed. What a
 * `StructureIndex` held by build tooling reads its fields through
 * (`fieldsOf`): the faceted-tree worker's, whose snapshot knows every blob.
 */
export async function recordedPluginFields(
  repo: RepoFiles,
  plugins: readonly string[],
): Promise<Map<string, PluginFields>> {
  const keyFilesOf = (dir: string) =>
    PLUGIN_KEY_FILES.map((keyFile) => `plugins/${dir}/${keyFile}`);
  const facts = await foldRepoFiles(
    repo,
    plugins.flatMap(keyFilesOf).filter((rel) => repo.has(rel)),
    keyFactsFold,
    null,
  );
  return new Map(
    plugins.map((dir) => [
      dir,
      pluginFieldsFrom(keyFilesOf(dir).map((rel) => facts[rel] ?? null)),
    ]),
  );
}
