import {
  composedHome,
  webListFacts,
  type WebListFact,
} from "@plugins/framework/plugins/server-core/core";
import type { AppDeclaration, AppEntry } from "../../core";

/** The `Apps.App` list (its slot id: apps-core's `app` key). */
const APPS_LIST = "apps-core.app";

/** One app's declaration, from its entry's fact. */
function declarationOf(f: WebListFact<AppEntry>): AppDeclaration {
  return {
    app: f.fact.app,
    launch:
      "surfaceMode" in f.fact && f.fact.surfaceMode !== undefined
        ? "surface"
        : "tab",
  };
}

/**
 * Every app this backend's composition registers in its browser (its Apps.App
 * contributions), as data: the facts of the `Apps.App` list in the list
 * catalog, kept to the plugins the composition loads (server-core's
 * `webListFacts`). Read at request time — the process root installs the
 * catalog before the graph loads.
 */
export function declaredApps(): readonly AppDeclaration[] {
  return declaredAppPlugins().map((d) => d.declaration);
}

/** One declared app with the web plugin that contributes it (dot-form id). */
export interface DeclaredAppOf {
  plugin: string;
  declaration: AppDeclaration;
}

let declared: readonly DeclaredAppOf[] | undefined;

/**
 * {@link declaredApps}, each with its contributing web plugin — for a reader
 * that needs to know where an app's code lives (its plugin subtree), not only
 * what it is. Sorted by app id, as the apps were always listed.
 */
export function declaredAppPlugins(): readonly DeclaredAppOf[] {
  declared ??= webListFacts<AppEntry>(APPS_LIST)
    .map((f) => ({ plugin: f.plugin, declaration: declarationOf(f) }))
    .sort((a, b) => a.declaration.app.id.localeCompare(b.declaration.app.id));
  return declared;
}

/**
 * The address root of this backend's composition: its home app's base path
 * when it serves that app at `/` (`homeAtRoot` — the public site's `/about`),
 * else null. What every address this backend hands out drops
 * (`primitives/pane/route-prefix/core`'s `addressPathOf`). A home declared at
 * root but missing from the declared apps throws.
 */
export function addressRoot(): string | null {
  const { home, homeAtRoot } = composedHome();
  if (!homeAtRoot) return null;
  const app = declaredApps().find((a) => a.app.id === home);
  if (app === undefined) {
    throw new Error(
      `[apps-core] the composition serves its home app "${home}" at / (homeAtRoot), but no declared app has that id`,
    );
  }
  return app.app.basePath;
}
