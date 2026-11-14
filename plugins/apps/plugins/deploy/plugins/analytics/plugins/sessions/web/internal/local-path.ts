/** What the replay needs of an app this page registers. */
export interface LocalApp {
  basePath: string;
  formerBasePaths?: readonly string[];
}

/** `path` is `base` or under it (an app's landing pane may write `;keys` on its base path). */
function under(base: string, path: string): boolean {
  return (
    base === "/" ||
    path === base ||
    path.startsWith(base + "/") ||
    path.startsWith(base + ";")
  );
}

/**
 * Where a page the visitor saw lives on THIS instance: the recorded path,
 * moved from an app's former base path to its current one (`/website/vision`
 * → `/about/vision` — the same 301 the gateway answers), or null when no app
 * here owns it (the site ships an app this instance does not have).
 *
 * The deployed site renders the same apps under the same base paths as this
 * instance, so a recorded path IS an in-app path here.
 */
export function localPathOf(
  path: string,
  apps: readonly LocalApp[],
): string | null {
  let moved = path;
  for (const app of apps)
    for (const former of app.formerBasePaths ?? [])
      if (under(former, path)) {
        moved = app.basePath + path.slice(former.length);
        break;
      }
  return apps.some((a) => under(a.basePath, moved)) ? moved : null;
}
