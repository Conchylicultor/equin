/**
 * Verification pass for what a tab shows when one of its plugins fails to
 * load (research/2026-09-10-global-stale-tab-plugin-loading.md, Part 2 + 3.1).
 *
 * Two scenarios, each in a FRESH browser context — Chrome remembers a failed
 * module import for the life of the page, so one scenario's failure must not
 * leak into the other:
 *
 *  a. **A background (deferred) plugin 404s** on the build the tab runs (a
 *     fault — no update explains it). No top banner. The Build tray carries
 *     the fault pill (red with the failed plugins named for a developer; a
 *     neutral retry, "Part of the app didn't load", for a user). A
 *     `plugin-load` report is filed (read from the deploy's database, so run
 *     it against your own build — main's is refused).
 *  b. **A core (eager) plugin 404s.** The explicit top banner lists it, and a
 *     `plugin-load` report is filed — which only happens once the report sink
 *     holds an emit made before the reporter registered (Part 3.1).
 *
 * The failure is made with `page.route`: the served registry chunk has the
 * plugin's loader import a marked URL, which 404s — exactly what a stale tab
 * saw when a rebuild deleted the files its import named. Only that plugin
 * breaks; the route chunk it shares with others keeps serving them (see "the
 * deploy" below). Its stage is read off the deploy's own `index.html`: a
 * plugin whose loader imports a chunk in the root page's `modulepreload` set
 * is core-stage (the preload set IS the boot closure); otherwise it is
 * deferred. Defaults below; override with `--deferred` / `--eager` (plugin
 * paths, e.g. `apps/plugins/story/plugins/lenses`).
 *
 * Manual only; nothing runs this automatically. Run it after `./equin
 * build` with:
 *
 *   ./equin run plugins/build/e2e/stale-tab-reload.ts [--color-scheme dark|light] [--out /tmp/stale-tab] [--deferred <plugin path>] [--eager <plugin path>] [--headed]
 *
 * Screenshots land at `<out>-{deferred,eager}-<scheme>.png`; run once per
 * scheme to get both.
 */

import type { Page } from "playwright";
import {
  agentFetch,
  arg,
  onBeforeFinish,
  openDeployDb,
  boot,
  detectOsColorScheme,
  pathUrl,
  report,
  snap,
  usage,
  withBrowser,
  type ColorScheme,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  ELEMENT_TIMEOUT_MS,
  waitFor,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";

const USAGE =
  "usage: ./equin run plugins/build/e2e/stale-tab-reload.ts [--color-scheme dark|light] [--out <prefix>] [--deferred <plugin path>] [--eager <plugin path>] [--headed]";

const schemeArg = arg("color-scheme");
if (schemeArg !== undefined && schemeArg !== "dark" && schemeArg !== "light") {
  usage(USAGE);
}
const colorScheme: ColorScheme = schemeArg ?? detectOsColorScheme();
const out = arg("out", "/tmp/stale-tab-reload");

// A leaf page of the public website: app content no eager surface imports, so
// breaking it breaks nothing else. And `fullscreen`: an eager action-bar toggle
// nothing imports, so breaking it costs one button and keeps the app standing.
const DEFAULT_DEFERRED = "apps/plugins/website/plugins/landing/plugins/contact";
const DEFAULT_EAGER = "fullscreen";

// The fault pill's name: a user's neutral retry, or a developer's red detail
// (`build/web` update-copy) — a plugin failing on the served build is a fault,
// not an update.
const BROKEN_NAME =
  /part of the app didn't load|failed to load on the build this tab runs/i;

const r = report(`stale-tab reload (${colorScheme})`);

// --------------------------------------------------------------- the deploy
//
// The page loads route chunks (`web-artifacts` link step): no plugin barrel is
// an import-map entry any more, and one chunk holds the definitions of many
// plugins — so 404ing the chunk a plugin's code lives in would break all of
// them (and, for a boot chunk the registry also imports statically, the page
// itself). What the build publishes per plugin is its registry entry
//
//   { pluginPath: "<p>", …, loader: …(() => __equinImportOnce("<chunk>",
//       () => import("<chunk>"))…), … }
//
// in the registry chunk the page boots from. The script points THAT entry's
// import (and its per-chunk memo key) at a URL of its own, and 404s that URL:
// exactly one plugin's load fails, as a stale tab's did when a rebuild removed
// the files its import named — the chunk itself still serves its other plugins.

/** The marker appended to a broken plugin's chunk URL: its request 404s. */
const BROKEN_MARK = "stale-tab-reload-broken";

/** One plugin's entry in the served registry chunk. */
interface RegistryEntry {
  pluginPath: string;
  /** The registry chunk's own URL path (`/artifacts/chunk.<hash>/index.js`). */
  registryUrl: string;
  /** The chunk URL its loader imports, as written in the registry (relative). */
  spec: string;
  /** The same, resolved to a URL path. */
  chunkUrl: string;
}

interface ServedGraph {
  /** Every chunk URL path the root page preloads: the boot (eager) closure. */
  preloaded: Set<string>;
  /** The preloaded chunks' text, by URL path. */
  chunks: Map<string, string>;
}

async function readServedGraph(): Promise<ServedGraph> {
  const res = await agentFetch("/");
  if (!res.ok) throw new Error(`GET / → ${res.status}`);
  const html = await res.text();
  const preloaded = new Set(
    [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map(
      (m) => new URL(m[1]!, pathUrl("/")).pathname,
    ),
  );
  const chunkUrls = [...preloaded].filter((u) =>
    u.startsWith("/artifacts/chunk."),
  );
  if (chunkUrls.length === 0) {
    throw new Error("served index.html preloads no /artifacts/chunk.* module");
  }
  const chunks = new Map<string, string>();
  await Promise.all(
    chunkUrls.map(async (u) => {
      const r = await agentFetch(u);
      if (!r.ok) throw new Error(`GET ${u} → ${r.status}`);
      chunks.set(u, await r.text());
    }),
  );
  return { preloaded, chunks };
}

/** One registry entry's loader, as written in a chunk's text. */
interface Loader {
  pluginPath: string;
  /** From the entry's `pluginPath:` key to the end of its loader's `import(…)`. */
  start: number;
  end: number;
  /** The chunk specifier its loader imports (relative to the chunk). */
  spec: string;
}

const LOADER_KEY = /pluginPath:\s*(["'`])([^"'`]+)\1/g;
const IMPORT_CALL = /import\(\s*(["'`])([^"'`]+)\1\s*\)/g;

/**
 * Every registry entry in a chunk's text: a `pluginPath:` key followed by its
 * loader's `import(…)` with no other key in between (so the import is that
 * entry's own — the registry writes `pluginPath`, `id`, `loader` in order).
 */
function loadersIn(text: string): Loader[] {
  const keys = [...text.matchAll(LOADER_KEY)];
  const loaders: Loader[] = [];
  keys.forEach((key, i) => {
    IMPORT_CALL.lastIndex = key.index + key[0].length;
    const imp = IMPORT_CALL.exec(text);
    const nextKey = keys[i + 1]?.index ?? text.length;
    if (!imp || imp.index > nextKey) return;
    loaders.push({
      pluginPath: key[2]!,
      start: key.index,
      end: imp.index + imp[0].length,
      spec: imp[2]!,
    });
  });
  return loaders;
}

/** `pluginPath`'s registry entry: exactly one across the served boot chunks. */
function findEntry(graph: ServedGraph, pluginPath: string): RegistryEntry {
  const found: RegistryEntry[] = [];
  for (const [registryUrl, text] of graph.chunks) {
    for (const l of loadersIn(text)) {
      if (l.pluginPath !== pluginPath) continue;
      const chunkUrl = new URL(l.spec, pathUrl(registryUrl)).pathname;
      found.push({ pluginPath, registryUrl, spec: l.spec, chunkUrl });
    }
  }
  if (found.length === 0) {
    usage(
      `${pluginPath}: no registry entry in this deploy's boot chunks (not a web plugin of this composition?)\n${USAGE}`,
    );
  }
  if (found.length > 1) {
    throw new Error(
      `${pluginPath}: ${found.length} registry entries in the boot chunks (${found.map((e) => e.registryUrl).join(", ")}) — cannot tell which one the page loads it by`,
    );
  }
  return found[0]!;
}

/** The registry entry to break for the `--<flagName>` plugin, checked against its stage. */
function pick(
  graph: ServedGraph,
  flagName: "deferred" | "eager",
  fallback: string,
): RegistryEntry {
  const entry = findEntry(graph, arg(flagName) ?? fallback);
  // A plugin is core-stage iff the chunk its loader imports is in the boot's
  // preload closure; a deferred plugin's chunk is preloaded only on its own
  // app's pages (`apps-core/app-preload`), never on the root page.
  const eager = graph.preloaded.has(entry.chunkUrl);
  if (flagName === "eager" && !eager) {
    usage(
      `--eager ${entry.pluginPath}: its chunk ${entry.chunkUrl} is not in the modulepreload set, so it is not core-stage\n${USAGE}`,
    );
  }
  if (flagName === "deferred" && eager) {
    usage(
      `--deferred ${entry.pluginPath}: its chunk ${entry.chunkUrl} is in the modulepreload set, so it is core-stage\n${USAGE}`,
    );
  }
  return entry;
}

/** The other plugins whose loaders import the same chunk — left loading fine. */
function chunkMates(graph: ServedGraph, entry: RegistryEntry): string[] {
  return loadersIn(graph.chunks.get(entry.registryUrl)!)
    .filter((l) => l.spec === entry.spec && l.pluginPath !== entry.pluginPath)
    .map((l) => l.pluginPath);
}

/**
 * Make `entry`'s plugin, and only it, fail to load: serve the registry chunk
 * with that entry's chunk URL (memo key and import alike) pointed at a marked
 * URL, and 404 every marked URL. Installed before navigating.
 */
async function breakPlugin(page: Page, entry: RegistryEntry): Promise<void> {
  const broken = `${entry.spec}?${BROKEN_MARK}`;
  await page.route(
    (u) => u.pathname === entry.registryUrl,
    async (route) => {
      const response = await route.fetch();
      const text = await response.text();
      const loader = loadersIn(text).find(
        (l) => l.pluginPath === entry.pluginPath && l.spec === entry.spec,
      );
      if (!loader) {
        throw new Error(
          `${entry.registryUrl} served without ${entry.pluginPath}'s loader of ${entry.spec}`,
        );
      }
      // Only this entry's own text: its memo key and its import.
      const body = text.slice(loader.start, loader.end);
      const rewritten = body.split(entry.spec).join(broken);
      const headers = { ...response.headers() };
      delete headers["content-encoding"];
      delete headers["content-length"];
      await route.fulfill({
        status: response.status(),
        headers,
        body: text.slice(0, loader.start) + rewritten + text.slice(loader.end),
      });
    },
  );
  await page.route(
    (u) => u.search.includes(BROKEN_MARK),
    (route) =>
      route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: "stale-tab-reload e2e: intercepted",
      }),
  );
}

// ---------------------------------------------------------------- the app
/**
 * The Reload segment of the Build pill, reachable while the floating bar is
 * still collapsed. Matched by its own label (the full message).
 */
function reloadChip(page: Page) {
  return page.getByLabel(BROKEN_NAME);
}

/** The floating action bar (the `FloatingAction` root carries `group/fa`). */
const FLOATING_BAR = ".group\\/fa";

/**
 * Make the chip hoverable: a floating (fullscreen) bar is collapsed until hovered;
 * a docked one is already open.
 */
async function revealActionBar(page: Page): Promise<void> {
  const bar = page.locator(FLOATING_BAR).first();
  if ((await bar.count()) === 0) return;
  await bar.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  await bar.hover();
  // The strip widens over a 200 ms max-width transition.
  await page.waitForTimeout(400);
}

/**
 * Wait until `locator` matches something, or the budget runs out. The harness's
 * condition wait rather than a Playwright wait, so not-there-yet is a value to
 * report, never an exception to catch.
 */
async function appears(
  locator: ReturnType<Page["locator"]>,
  timeoutMs = ELEMENT_TIMEOUT_MS,
): Promise<boolean> {
  const seen = await waitFor(
    () => locator.count(),
    (n) => n > 0,
    { timeoutMs },
  );
  return seen.ok;
}

/** How many boot banners (a fixed red strip) name `pluginPath`. */
async function bannerNaming(page: Page, pluginPath: string): Promise<number> {
  return page
    .locator("div.fixed.bg-destructive")
    .filter({ hasText: pluginPath })
    .count();
}

/** The deploy's database: where the `plugin-load` report lands. */
const db = openDeployDb();
onBeforeFinish(() => db.close());

/** The fields of a report row this script reads. */
interface ReportRow extends Record<string, unknown> {
  id: string;
  count: number;
  last_seen_at: Date;
}

/** A `plugin-load` report for `pluginPath` seen since `sinceMs`, if any. */
async function reportFor(
  pluginPath: string,
  sinceMs: number,
): Promise<ReportRow | undefined> {
  // A report dedupes by fingerprint, so a re-run bumps an existing row: what
  // proves THIS run filed it is the row having been touched since.
  const rows = await db.query<ReportRow>(
    `SELECT id, count, last_seen_at FROM reports
      WHERE source = 'plugin-load' AND data->>'errorType' = $1
        AND last_seen_at >= $2
      ORDER BY last_seen_at DESC LIMIT 1`,
    [`PluginLoadError ${pluginPath}`, new Date(sinceMs)],
  );
  return rows[0];
}

/**
 * The report-delivery half. A report may retry through a server restart for
 * ~30 s before it lands, so the budget outlasts that.
 */
async function assertReported(pluginPath: string, sinceMs: number) {
  const seen = await waitFor(
    () => reportFor(pluginPath, sinceMs),
    (row) => row !== undefined,
    { timeoutMs: 45_000, intervalMs: 1000 },
  );
  r.ok(
    `a plugin-load report was filed for ${pluginPath}`,
    seen.ok,
    `none touched since ${new Date(sinceMs).toISOString()} after ${seen.waitedMs} ms`,
  );
  if (seen.value) {
    r.note(
      `report ${seen.value.id}: count ${seen.value.count}, last seen ${seen.value.last_seen_at.toISOString()}`,
    );
  }
  r.note(
    `DB check: SELECT id, count, last_seen_at, message FROM reports WHERE source = 'plugin-load' AND data->>'errorType' = 'PluginLoadError ${pluginPath}' ORDER BY last_seen_at DESC;`,
  );
}

const graph = await readServedGraph();
const deferred = pick(graph, "deferred", DEFAULT_DEFERRED);
const eager = pick(graph, "eager", DEFAULT_EAGER);
for (const [stage, e] of [
  ["deferred", deferred],
  ["eager", eager],
] as const) {
  r.note(
    `${stage} target: ${e.pluginPath} — its loader's import of ${e.chunkUrl} (in registry ${e.registryUrl}) is pointed at a 404; the other plugins loading that chunk are left working: ${chunkMates(graph, e).join(", ") || "none"}`,
  );
}

await withBrowser(async (h) => {
  // ------------------------------------------------ a. deferred failure
  {
    const { page } = await h.session({ colorScheme });
    await breakPlugin(page, deferred);
    // Server clock and this clock are the same host's; the slop only absorbs
    // the report's own timestamp rounding.
    const since = Date.now() - 2000;
    await boot(page, pathUrl("/"), { settleMs: 1500 });

    // The deferred tier drains after first paint, so the chip turns red a
    // beat later. Counted, not waited visible: the bar is still collapsed, so
    // the chip is in the DOM but clipped.
    const chip = reloadChip(page).first();
    const appeared = await appears(reloadChip(page));
    r.ok(
      "deferred failure: the Build pill carries a red Reload segment",
      appeared,
    );

    if (appeared) {
      const cls = (await chip.getAttribute("class")) ?? "";
      r.ok(
        "deferred failure: the segment is destructive",
        cls.includes("destructive"),
        cls,
      );
      r.eq(
        "deferred failure: the segment is its own <button> in the Build tray, not nested in the Build button",
        await chip.evaluate((el) => ({
          tag: el.tagName,
          inButton: el.parentElement?.closest("button") != null,
        })),
        { tag: "BUTTON", inButton: false },
      );
    }

    r.eq(
      "deferred failure: no boot banner names it",
      await bannerNaming(page, deferred.pluginPath),
      0,
    );
    r.eq(
      "deferred failure: no boot banner at all",
      await page.locator("div.fixed.bg-destructive").count(),
      0,
    );

    await revealActionBar(page);
    if (appeared) {
      await chip.hover();
      // The segment's own text is "Reload" (the message is its aria-label,
      // which is not text), so anything showing the message as TEXT is a tooltip.
      const shown = await waitFor(
        () => page.getByText(BROKEN_NAME).first().isVisible(),
        (v) => v,
        { timeoutMs: 5000 },
      );
      r.ok(
        "deferred failure: hovering the segment shows the didn't-load tooltip",
        shown.ok,
      );
    }
    await snap(page, out, `deferred-${colorScheme}`);

    await assertReported(deferred.pluginPath, since);
    await page.context().close();
  }

  // ------------------------------------------------ b. eager failure
  {
    const { page } = await h.session({ colorScheme });
    await breakPlugin(page, eager);
    const since = Date.now() - 2000;
    await boot(page, pathUrl("/"), { settleMs: 1500 });

    const shown = await appears(
      page
        .locator("div.fixed.bg-destructive")
        .filter({ hasText: eager.pluginPath }),
    );
    r.ok("eager failure: the boot banner lists it", shown);
    // An eager failure also lands in the failed set, so the chip is red too —
    // recorded, not asserted: the plan pins only the banner for this stage.
    r.note(
      `eager failure: red Reload chip present = ${(await reloadChip(page).count()) > 0}`,
    );
    await snap(page, out, `eager-${colorScheme}`);

    await assertReported(eager.pluginPath, since);
    await page.context().close();
  }
});

await r.finish();
