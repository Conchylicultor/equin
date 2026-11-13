const APP_ROOT_RE = /^(apps\/plugins\/[^/]+)\//;

/**
 * The app subtree a plugin lies in — `apps/plugins/<app>/` (trailing slash, so
 * it is a path prefix that cannot match a sibling app) — or `null` for a
 * plugin outside every app. A plugin path is the repo path below `plugins/`
 * (`apps/plugins/website/plugins/shell`).
 *
 * The unit the boot loads an app's code by: every deferred plugin under the
 * active app's root is its priority batch (web-core's `App.tsx`), and the same
 * root keys the batch's preloads in the served dist ({@link AppPreloads}).
 */
export function appRootOf(pluginPath: string): string | null {
  const m = APP_ROOT_RE.exec(pluginPath);
  return m ? m[1] + "/" : null;
}
