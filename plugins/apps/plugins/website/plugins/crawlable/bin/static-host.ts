// The crawlable snapshot's take, run ONCE per snapshot address by the build
// (web-artifacts' crawl-snapshot stage, in a fresh Bun process, only for a
// composition declared `crawlable: true`):
//
//   static-host.ts <composition> <out-dir> <cluster-file>
//
// 1. boots the composition's portable server graph in-process on PGlite,
//    opened from the initialized cluster the build hands over
//    (`./static-host.generated.ts`, inferred by codegen's static-host-gen);
// 2. assembles its boot snapshot (the `/api/resources/boot-snapshot` body)
//    and reads its pages (`WebsitePages.Page`);
// 3. renders every page by its path through the composition's web plugins
//    (`../plugins/snapshot-render/web`'s `renderSiteSnapshot` over
//    static-render — build-only code, in no composition);
// 4. writes, under `<out-dir>`, the files it adds to the composition's web
//    dist: the fragments under `snapshot/`, then `snapshot/manifest.json`
//    LAST (temp file + rename), so no reader sees a manifest naming a fragment
//    not yet written.
//
// Any render failure or page without text fails the take, naming the page.
import "./declare-namespace"; // MUST stay first: see the file.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { declareInitializedMemoryStorage } from "@plugins/framework/plugins/browser-server/plugins/host-storage/core";
import { bootBrowserHost } from "@plugins/framework/plugins/server-core/core";
import type { PluginEntry } from "@plugins/framework/plugins/web-sdk/core";
import { unmatchedApiResponse } from "@plugins/infra/plugins/endpoints/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { assembleBootSnapshot } from "@plugins/network/plugins/live/plugins/boot-snapshot/server";
import {
  importBarrel,
  inlineAssetImports,
  registerBarrelStubs,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import {
  SNAPSHOT_MANIFEST_PATH,
  SnapshotManifestSchema,
  type SnapshotManifest,
  type WebsitePage,
} from "../core";
import { WebsitePages } from "../server";
import { withDiskProviders } from "@plugins/framework/plugins/browser-server/plugins/bun-host/cli";
import { staticHosts } from "./static-host.generated";

// The render half's surface, restated: a `bin/` imports no `web/` barrel, so
// it is loaded through barrel-import. It is no web plugin of any composition
// (base-exclusions keeps it, and static-render, out of every browser
// registry); the snapshot's address covers it as a web barrel of this
// plugin's subtree (web-artifacts' crawl-snapshot).
type RenderSiteSnapshot = (opts: {
  entries: PluginEntry[];
  composition: (typeof staticHosts)[string]["composition"];
  bootSnapshot: Awaited<ReturnType<typeof assembleBootSnapshot>>;
  pages: readonly WebsitePage[];
}) => Promise<{
  manifest: SnapshotManifest;
  fragments: ReadonlyMap<string, string>;
  timings: { path: string; ms: number }[];
}>;

const RENDER_BARREL =
  "apps/plugins/website/plugins/crawlable/plugins/snapshot-render/web/index.ts";

/** A web plugin's dot-form id, from its plugin path (`a/plugins/b` → `a.b`). */
function webPluginId(pluginPath: string): string {
  return pluginPath.split("/plugins/").join(".");
}

const [composition, outDir, cluster] = process.argv.slice(2);
if (outDir === undefined || cluster === undefined) {
  throw new Error(
    "usage: static-host.ts <composition> <out-dir> <cluster-file>",
  );
}
const host = staticHosts[composition!];
if (host === undefined) {
  throw new Error(
    `[crawlable] "${composition}" is no crawlable composition (crawlable: ${Object.keys(staticHosts).join(", ") || "none"}) — set \`crawlable: true\` on its row and rebuild`,
  );
}

const t0 = performance.now();
declareInitializedMemoryStorage(new Blob([readFileSync(cluster)]));
const booted = await bootBrowserHost({
  entries: withDiskProviders(host.hostEntries, host.hostProviders),
  onUnmatched: unmatchedApiResponse,
});
await booted.settled;
// The composition's own page boots from this snapshot: its tuples are those
// the composition's web plugins read.
const bootSnapshot = await assembleBootSnapshot({
  webPlugins: new Set(host.webPlugins.map(webPluginId)),
});
const pages = [...WebsitePages.Page.getContributions()].sort((a, b) =>
  a.path.localeCompare(b.path),
);
if (pages.length === 0) {
  throw new Error(
    `[crawlable] composition "${composition}" declares no page (WebsitePages.Page) — nothing to snapshot`,
  );
}
const t1 = performance.now();

registerBarrelStubs(REPO_ROOT);
// An image import evaluates to the data URL the browser build inlines.
inlineAssetImports();
const render = (await importBarrel(join(REPO_ROOT, "plugins", RENDER_BARREL)))[
  "renderSiteSnapshot"
] as RenderSiteSnapshot | undefined;
if (typeof render !== "function") {
  throw new Error(`[crawlable] ${RENDER_BARREL} exports no renderSiteSnapshot`);
}
const { manifest, fragments, timings } = await render({
  entries: host.webPlugins.map((pluginPath) => ({
    pluginPath,
    id: webPluginId(pluginPath),
    loader: () =>
      importBarrel(
        join(REPO_ROOT, "plugins", pluginPath, "web/index.ts"),
      ) as Promise<{ default: unknown }>,
  })),
  composition: host.composition,
  bootSnapshot,
  pages,
});
const t2 = performance.now();

// Fragments first, the manifest last and atomically.
const manifestFile = join(outDir, SNAPSHOT_MANIFEST_PATH);
const snapshotDir = dirname(manifestFile);
for (const [file, html] of fragments) {
  const abs = join(snapshotDir, file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, html);
}
const tmp = `${manifestFile}.tmp`;
writeFileSync(
  tmp,
  `${JSON.stringify(SnapshotManifestSchema.parse(manifest), null, 2)}\n`,
);
renameSync(tmp, manifestFile);

console.info(
  `[crawlable snapshot] ${composition}: ${pages.length} pages — boot ${Math.round(t1 - t0)} ms, render ${Math.round(t2 - t1)} ms (${timings.map((t) => `${t.path} ${t.ms} ms`).join(", ")})`,
);
// The booted host's watchers and job timers keep the event loop alive: this
// process exists to write the files, and is done.
process.exit(0);
