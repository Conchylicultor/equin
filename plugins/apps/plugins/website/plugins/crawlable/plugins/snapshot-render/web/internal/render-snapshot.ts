import type {
  CompositionIdentity,
  PluginEntry,
} from "@plugins/framework/plugins/web-sdk/core";
import type { BootSnapshotValues } from "@plugins/network/plugins/live/plugins/boot-snapshot/web";
import { createStaticRenderer } from "@plugins/primitives/plugins/dom/plugins/static-render/web";
import { semanticHtml } from "@plugins/primitives/plugins/dom/plugins/static-render/core";
import { documentTitle } from "@plugins/apps-core/core";
import {
  SnapshotPageError,
  snapshotFiles,
  type SnapshotManifest,
  type SnapshotTaken,
  type WebsitePage,
} from "@plugins/apps/plugins/website/plugins/crawlable/core";

/**
 * Render a composition's pages once, for robots: the static half of the
 * crawlable snapshot, run by the snapshot take (`crawlable/bin/static-host.ts`)
 * in a Bun process — never in a browser (this plugin is in no composition).
 *
 * Each page is rendered by its path alone through the real app
 * (`createStaticRenderer`: the composition's plugins over `bootSnapshot`, the
 * pane the path resolves to), filtered to its semantic document, and titled
 * as the live app titles its tab (`documentTitle` — the pane's title and its
 * app's name). The manifest's `home` is the composition's home app's base
 * path (what bare `/` goes to), its `moved` every app's former base paths
 * (`AppRef.formerBasePaths`). Any render error, or a page without text,
 * throws a `SnapshotPageError` naming the page.
 */
export async function renderSiteSnapshot(opts: {
  entries: PluginEntry[];
  composition: CompositionIdentity;
  bootSnapshot: BootSnapshotValues;
  pages: readonly WebsitePage[];
}): Promise<{
  manifest: SnapshotManifest;
  fragments: ReadonlyMap<string, string>;
  /** Per page, in order: its path and how long its render took. */
  timings: { path: string; ms: number }[];
}> {
  const renderer = await createStaticRenderer({
    entries: opts.entries,
    composition: opts.composition,
    bootSnapshot: opts.bootSnapshot,
  });
  if (renderer.unhydrated.length > 0) {
    throw new Error(
      `[crawlable] the boot snapshot carries keys no loaded plugin declares: ${renderer.unhydrated.join(", ")}`,
    );
  }
  const taken: SnapshotTaken[] = [];
  const timings: { path: string; ms: number }[] = [];
  for (const page of opts.pages) {
    const t0 = performance.now();
    let rendered;
    try {
      rendered = await renderer.render({ path: page.path });
    } catch (err) {
      throw new SnapshotPageError(
        page.path,
        err instanceof Error ? err.message : String(err),
        { cause: err },
      );
    }
    taken.push({
      page,
      title: documentTitle({ entity: rendered.title, app: rendered.app.name }),
      semantic: semanticHtml(rendered.html),
    });
    timings.push({ path: page.path, ms: Math.round(performance.now() - t0) });
  }
  return {
    ...snapshotFiles(taken, renderer.home?.basePath ?? null, renderer.moved),
    timings,
  };
}
