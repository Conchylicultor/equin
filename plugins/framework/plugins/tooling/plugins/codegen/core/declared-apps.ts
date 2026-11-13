import {
  existsSync,
  readdirSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  isTestCodePath,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import { foldRepoFiles } from "@plugins/plugin-meta/plugins/plugin-records/core";
import type {
  PluginNode,
  PluginTree,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { declaredAppsFold, defineAppCallIn } from "./declared-apps.scan";

/** One `defineApp({...})` call, read statically off an app shell's `core/`. */
export interface DeclaredApp {
  /** The app id (`defineApp({ id })`) — what a composition's `home` names. */
  id: string;
  /** The Material Symbols name of its `icon: symbol("…")`, or null when the call declares none. */
  iconKey: string | null;
  /** The plugin whose `core/` declares it — the app's shell. */
  plugin: PluginId;
  /** The declaring file, for error messages. */
  file: string;
}

/**
 * The app `node` ITSELF declares — the `defineApp({...})` in its own `core/*.ts`
 * (not its descendants') — or null. Static, barrel-free: every app shell writes
 * `defineApp({ id: "…", …, icon: symbol("…") })` with string literals in `core/app.ts`
 * (tsc checks the literals; this only reads them back). A `defineApp` without a
 * literal `id` throws — an app the build cannot name is not one to guess at.
 *
 * Reads the plugin's `core/` off disk: for a caller asking about ONE plugin (a
 * release names its app). A whole tree is {@link readDeclaredApps}.
 */
export function readDefineApp(node: PluginNode): DeclaredApp | null {
  return readDefineAppIn(node.dir, node.id);
}

/**
 * `readDefineApp` for a plugin named by its directory and id rather than a tree
 * node — for callers that know a plugin set (a composition's registry) without
 * having walked the tree.
 */
export function readDefineAppIn(
  pluginDir: AppPath,
  plugin: PluginId,
): DeclaredApp | null {
  const coreDir = joinAppPath(pluginDir, "core");
  if (!existsSync(coreDir)) return null;
  for (const f of readdirSync(coreDir).sort()) {
    if (!f.endsWith(".ts") || isTestCodePath([f])) continue;
    const file = joinAppPath(coreDir, f);
    const call = defineAppCallIn(readFileSync(file, "utf8"), file);
    if (call !== null) return { ...call, plugin, file };
  }
  return null;
}

/** A `.ts` file directly under a plugin's `core/`; group 1 is the plugin's path under `plugins/`. */
const CORE_FILE_RE = /^plugins\/([^/]+(?:\/plugins\/[^/]+)*)\/core\/[^/]+\.ts$/;

/**
 * Every app the checkout declares, by app id → its declaration. THE static
 * answer to "which plugin is app X?", read by `composition-closure` and registry
 * codegen to resolve a composition's `home`. Throws on two shells declaring one
 * id — the id is the app's identity, so a duplicate makes `home` ambiguous.
 *
 * Read off the tree's file set: each plugin's `core/*.ts` is a plugin record
 * (`declaredAppsFold`), so a pass reads only the `core/` files it has not
 * folded yet — never every plugin's `core/` on disk (a stat, a listing and a
 * read per file: ~4.6k calls per tree). A plugin's app is its first `core/`
 * file, by name, that declares one.
 */
export async function readDeclaredApps(
  tree: PluginTree,
): Promise<Map<string, DeclaredApp>> {
  const { repo } = tree;
  const files = repo.under("plugins").filter((rel) => {
    const m = CORE_FILE_RE.exec(rel);
    return (
      m !== null && !isTestCodePath(rel.split("/")) && tree.byPath.has(m[1]!)
    );
  });
  const calls = (await foldRepoFiles(repo, files, declaredAppsFold, null))
    .slice()
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const byPlugin = new Map<string, DeclaredApp>();
  for (const call of calls) {
    const pluginPath = CORE_FILE_RE.exec(call.rel)![1]!;
    if (byPlugin.has(pluginPath)) continue;
    byPlugin.set(pluginPath, {
      id: call.id,
      iconKey: call.iconKey,
      plugin: tree.byPath.get(pluginPath)!.id,
      file: joinAppPath(repo.root, call.rel),
    });
  }
  const apps = new Map<string, DeclaredApp>();
  for (const node of tree.byDir.values()) {
    const app = byPlugin.get(node.path);
    if (app === undefined) continue;
    const prior = apps.get(app.id);
    if (prior) {
      throw new Error(
        `Two plugins declare the app id "${app.id}": ${prior.file} and ${app.file}.`,
      );
    }
    apps.set(app.id, app);
  }
  return apps;
}
