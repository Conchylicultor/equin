import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  isTestCodePath,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  findMarkerCalls,
  parseStringField,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import type {
  PluginNode,
  PluginTree,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";

/** One `defineApp({...})` call, read statically off an app shell's `core/`. */
export interface DeclaredApp {
  /** The app id (`defineApp({ id })`) — what a composition's `home` names. */
  id: string;
  /** The Material Symbols name, or null when the call declares none. */
  iconKey: string | null;
  /** The plugin whose `core/` declares it — the app's shell. */
  plugin: PluginId;
  /** The declaring file, for error messages. */
  file: string;
}

/** A static string field of a `defineApp({...})` argument; null when absent or dynamic. */
function stringProp(argsText: string, key: string): string | null {
  const r = parseStringField(argsText, key);
  return r.kind === "value" ? r.value : null;
}

/**
 * The app `node` ITSELF declares — the `defineApp({...})` in its own `core/*.ts`
 * (not its descendants') — or null. Static, barrel-free: every app shell writes
 * `defineApp({ id: "…", …, iconKey: "…" })` with string literals in `core/app.ts`
 * (tsc checks the literals; this only reads them back). A `defineApp` without a
 * literal `id` throws — an app the build cannot name is not one to guess at.
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
  pluginDir: string,
  plugin: PluginId,
): DeclaredApp | null {
  const coreDir = join(pluginDir, "core");
  if (!existsSync(coreDir)) return null;
  for (const f of readdirSync(coreDir).sort()) {
    if (!f.endsWith(".ts") || isTestCodePath([f])) continue;
    const file = join(coreDir, f);
    // Genuine calls only — a `defineApp(…)` in a comment or string never counts —
    // with an object-literal argument (not the `function defineApp(def: …)`
    // declaration itself).
    const body = findMarkerCalls(readFileSync(file, "utf8"), "defineApp")
      .map((c) => c.argsText.trim())
      .find((a) => a.startsWith("{"));
    if (body === undefined) continue;
    const id = stringProp(body, "id");
    if (id === null) {
      throw new Error(
        `${file} calls defineApp(...) without a string-literal \`id\`. ` +
          `Composition homes and releases read app ids statically — write it as a literal.`,
      );
    }
    return { id, iconKey: stringProp(body, "iconKey"), plugin, file };
  }
  return null;
}

/**
 * Every app the checkout declares, by app id → its declaration. THE static
 * answer to "which plugin is app X?", read by `composition-closure` and registry
 * codegen to resolve a composition's `home`. Throws on two shells declaring one
 * id — the id is the app's identity, so a duplicate makes `home` ambiguous.
 */
export function readDeclaredApps(tree: PluginTree): Map<string, DeclaredApp> {
  const apps = new Map<string, DeclaredApp>();
  for (const node of tree.byDir.values()) {
    const app = readDefineApp(node);
    if (app === null) continue;
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
