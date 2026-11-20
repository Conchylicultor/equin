import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import {
  catalogFor,
  type WebCatalog,
  type WebListDeclaration,
  type WebListEntry,
} from "@plugins/framework/plugins/list-catalog/core";

/** The committed list catalog's two web files (codegen's `list-catalog-gen.ts`). */
const WEB_LISTS_REL =
  "plugins/framework/plugins/list-catalog/plugins/web-lists/core/web-lists.generated.ts";
const WEB_LIST_ENTRIES_REL =
  "plugins/framework/plugins/server-core/core/web-list-entries.generated.json";

/**
 * web-sdk declares its own lists (`Core.Root`, `Core.Boot`) on its core barrel:
 * it is the runtime, on every page, though no registry lists it.
 */
const WEB_SDK_PLUGIN = "framework.web-sdk";

/** The two catalog modules of a composition's registry artifact. */
export interface PageCatalogSources {
  /** `catalog.js`: the page's own plugins — loaded upfront. */
  page: string;
  /** `catalog-on-demand.js`: with its on-demand plugins — loaded with them. */
  onDemand: string;
}

/**
 * The page's catalog modules: the repo's list catalog kept to the web plugins
 * this composition's registry loads — an entry's fact is a function of its
 * plugin alone, so the kept part IS this composition's catalog. `page` keeps
 * its own plugins (served as `catalog.js` of the registry artifact behind
 * `@composition-web-catalog`, handed to the PluginProvider by App.tsx, so the
 * page knows every list's entries before any plugin loads); `onDemand` adds
 * the plugins a browser host's scope loads when asked (`catalog-on-demand.js`
 * behind `@composition-web-catalog-on-demand`, loaded with them).
 */
export async function renderPageCatalog(
  root: AppPath,
  pluginIds: readonly string[],
  onDemandIds: readonly string[],
): Promise<PageCatalogSources> {
  // Both read as bytes, never `import()`ed: a process's module cache would
  // hand a second build in it the first build's copy. The lists file holds
  // one JSON object a line (codegen's `renderWebLists`).
  const webLists = (await readFile(joinAppPath(root, WEB_LISTS_REL), "utf8"))
    .split("\n")
    .filter((line) => line.startsWith('  {"id":'))
    .map(
      (line) => JSON.parse(line.trim().replace(/,$/, "")) as WebListDeclaration,
    );
  const webListEntries = JSON.parse(
    await readFile(joinAppPath(root, WEB_LIST_ENTRIES_REL), "utf8"),
  ) as readonly WebListEntry[];
  const source = (ids: readonly string[]): string => {
    const catalog: WebCatalog = catalogFor(
      { lists: webLists, entries: webListEntries },
      new Set([...ids, WEB_SDK_PLUGIN]),
    );
    // One JSON.parse of a string, not an object literal: a large literal
    // costs the page more to parse than the JSON it holds.
    return `export const webCatalog = JSON.parse(${JSON.stringify(JSON.stringify(catalog))});\n`;
  };
  return {
    page: source(pluginIds),
    onDemand: source([...pluginIds, ...onDemandIds]),
  };
}
