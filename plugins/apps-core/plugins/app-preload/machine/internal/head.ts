import { declaredAppPlugins } from "@plugins/apps-core/server";
import {
  asFsPath,
  asPluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import { webDistDir } from "@plugins/infra/plugins/paths/server";
import { exists, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import type { HeadFragments } from "@plugins/shell/plugins/document-head/server";
import {
  APP_PRELOADS_FILE,
  appRootOf,
  AppPreloadsSchema,
  type AppPreloads,
} from "../../core";

const log = Log.channel("app-preload");

/** Attribute-safe text (the URLs are ours and content-addressed; belt and braces). */
function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * The served dist's per-app preloads. A dist without the file was composed
 * before compose wrote it — the page then loads each app's code as it always
 * did (after the eager tier), slower but correct — so it reads as "no
 * preloads" and says so in the log rather than failing the whole head.
 */
async function readAppPreloads(): Promise<AppPreloads> {
  const file = `${webDistDir()}/${APP_PRELOADS_FILE}`;
  if (!(await exists(file))) {
    log.publish(`no ${file}: the served dist predates per-app preloads`);
    return { v: 1, apps: {} };
  }
  // A file that is there but unreadable or malformed is a compose bug: loud.
  return AppPreloadsSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

/**
 * Pure: the head fragments for a set of declared apps and the dist's preloads
 * — per app base path, a `<link rel="modulepreload">` for every module its
 * deferred plugins load, so they download from t0 alongside the shell's own
 * preloads instead of after the first frame.
 *
 * Every app gets a key, even one with nothing to preload (`""`): a base path
 * nested in another app's (`/home/menu-bar` in `/home`) must not inherit that
 * app's preloads by longest match. A surface-mode app's base path prefixes the
 * pages of the apps it shows (`/desktop/agents/c/x`), so each tab app is also
 * keyed under it.
 */
export function renderAppPreloadHead(
  apps: readonly {
    plugin: string;
    basePath: string;
    launch: "tab" | "surface";
  }[],
  preloads: AppPreloads,
): HeadFragments {
  const htmlOf = (plugin: string): string => {
    const root = appRootOf(asFsPath(asPluginId(plugin)));
    const urls = root === null ? [] : (preloads.apps[root] ?? []);
    return urls
      .map((url) => `<link rel="modulepreload" href="${attr(url)}">`)
      .join("");
  };
  const head: HeadFragments = {};
  for (const app of apps) head[app.basePath] = htmlOf(app.plugin);
  for (const surface of apps) {
    if (surface.launch !== "surface") continue;
    for (const app of apps) {
      if (app.launch !== "tab") continue;
      head[surface.basePath + app.basePath] = htmlOf(app.plugin);
    }
  }
  return head;
}

// Re-render triggers: a deploy this backend adopts without restarting serves
// another dist (a restart re-renders at boot anyway).
const listeners = new Set<() => void>();

/** The dist changed under this backend: every subscriber re-renders. */
export function notifyDistAdopted(): void {
  for (const l of listeners) l();
}

/** The head fragments of this backend's apps, from the dist it serves. */
export async function renderAppPreloads(): Promise<HeadFragments> {
  return renderAppPreloadHead(
    declaredAppPlugins().map(({ plugin, declaration }) => ({
      plugin,
      basePath: declaration.app.basePath,
      launch: declaration.launch,
    })),
    await readAppPreloads(),
  );
}

/** Hear that the served dist changed under this backend. */
export function subscribeAppPreloads(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}
