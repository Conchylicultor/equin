/**
 * Verification pass for what a tab shows when one of its plugins fails to
 * load (research/2026-09-10-global-stale-tab-plugin-loading.md, Part 2 + 3.1).
 *
 * Two scenarios, each in a FRESH browser context — Chrome remembers a failed
 * module import for the life of the page, so one scenario's failure must not
 * leak into the other:
 *
 *  a. **A background (deferred) plugin 404s.** No top banner. The Build
 *     pill's Reload segment is red, named "Part of the app didn't load", and the
 *     collapsed action-bar dot is red. A `plugin-load` report is filed.
 *  b. **A core (eager) plugin 404s.** The explicit top banner lists it, and a
 *     `plugin-load` report is filed — which only happens once the report sink
 *     holds an emit made before the reporter registered (Part 3.1).
 *
 * The failure is made with `page.route` fulfilling the plugin's artifact URL
 * with a 404 — exactly what a stale tab saw when a rebuild deleted the folder
 * its import map pointed into. Which plugin to break is read off the deploy's
 * own `index.html`: a plugin whose barrel is in the `modulepreload` set is
 * core-stage (the preload set IS the eager closure); one in the import map but
 * not preloaded is deferred. Defaults below; override with `--deferred` /
 * `--eager` (plugin paths, e.g. `apps/plugins/story/plugins/lenses`).
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
  boot,
  detectOsColorScheme,
  ELEMENT_TIMEOUT_MS,
  pathUrl,
  report,
  snap,
  usage,
  waitFor,
  withBrowser,
  type ColorScheme,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

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

const BROKEN_NAME = /part of the app didn't load/i;

const r = report(`stale-tab reload (${colorScheme})`);

// --------------------------------------------------------------- the deploy
/** Plugin path → its web barrel's artifact URL, and which of those preload. */
interface ServedGraph {
  barrels: Map<string, string>;
  preloaded: Set<string>;
}

async function readServedGraph(): Promise<ServedGraph> {
  const res = await agentFetch("/");
  if (!res.ok) throw new Error(`GET / → ${res.status}`);
  const html = await res.text();
  const map = /<script type="importmap"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!map) throw new Error("served index.html carries no import map");
  const { imports } = JSON.parse(map[1]!) as {
    imports: Record<string, string>;
  };
  const barrels = new Map<string, string>();
  for (const [specifier, url] of Object.entries(imports)) {
    const m = /^@plugins\/(.+)\/web$/.exec(specifier);
    if (m) barrels.set(m[1]!, url);
  }
  const preloaded = new Set(
    [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map(
      (m) => m[1]!,
    ),
  );
  return { barrels, preloaded };
}

/** The artifact URL to break for `pluginPath`, checked against its stage. */
function pick(
  graph: ServedGraph,
  flagName: "deferred" | "eager",
  fallback: string,
): { pluginPath: string; url: string } {
  const pluginPath = arg(flagName) ?? fallback;
  const url = graph.barrels.get(pluginPath);
  if (url === undefined) {
    usage(
      `--${flagName} ${pluginPath}: no web barrel in this deploy's import map\n${USAGE}`,
    );
  }
  const eager = graph.preloaded.has(url);
  if (flagName === "eager" && !eager) {
    usage(
      `--eager ${pluginPath} is not in the modulepreload set, so it is not core-stage\n${USAGE}`,
    );
  }
  if (flagName === "deferred" && eager) {
    usage(
      `--deferred ${pluginPath} is in the modulepreload set, so it is core-stage\n${USAGE}`,
    );
  }
  return { pluginPath, url };
}

/** Fulfill exactly this artifact's entry file with a 404, before navigating. */
async function breakArtifact(page: Page, url: string): Promise<void> {
  const target = new URL(pathUrl(url)).pathname;
  await page.route(
    (u) => u.pathname === target,
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
 * The action bar's status dot, whichever host renders it: docked in the tab bar
 * (desktop and tab modes) or floating (fullscreen). Both put the status glyph beside
 * the action row, so it is the dot in the chip's nearest ancestor that has one.
 */
function statusDot(page: Page) {
  return reloadChip(page)
    .first()
    .locator(
      'xpath=ancestor::*[.//*[contains(@class,"ring-background")]][1]//*[contains(@class,"ring-background")]',
    )
    .first();
}

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

/**
 * The fields of a report row this script reads, as they arrive on the wire
 * (`GET /api/resources/reports` → `{ value }`; dates are ISO strings there).
 */
interface ReportRow {
  id: string;
  source: string;
  data: Record<string, unknown>;
  count: number;
  lastSeenAt: string;
}

/** A `plugin-load` report for `pluginPath` seen since `sinceMs`, if any. */
async function reportFor(
  pluginPath: string,
  sinceMs: number,
): Promise<ReportRow | undefined> {
  const res = await agentFetch("/api/resources/reports");
  if (!res.ok) throw new Error(`GET /api/resources/reports → ${res.status}`);
  const { value } = (await res.json()) as { value: ReportRow[] };
  return value.find(
    (row) =>
      row.source === "plugin-load" &&
      row.data.errorType === `PluginLoadError ${pluginPath}` &&
      // A report dedupes by fingerprint, so a re-run bumps an existing row:
      // what proves THIS run filed it is the row having been touched since.
      Date.parse(row.lastSeenAt) >= sinceMs,
  );
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
      `report ${seen.value.id}: count ${seen.value.count}, last seen ${seen.value.lastSeenAt}`,
    );
  }
  r.note(
    `DB check: SELECT id, count, last_seen_at, message FROM reports WHERE source = 'plugin-load' AND data->>'errorType' = 'PluginLoadError ${pluginPath}' ORDER BY last_seen_at DESC;`,
  );
}

const graph = await readServedGraph();
const deferred = pick(graph, "deferred", DEFAULT_DEFERRED);
const eager = pick(graph, "eager", DEFAULT_EAGER);
r.note(`deferred target: ${deferred.pluginPath} → ${deferred.url}`);
r.note(`eager target:    ${eager.pluginPath} → ${eager.url}`);

await withBrowser(async (h) => {
  // ------------------------------------------------ a. deferred failure
  {
    const { page } = await h.session({ colorScheme });
    await breakArtifact(page, deferred.url);
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
        cls.includes("text-destructive"),
        cls,
      );
      r.eq(
        "deferred failure: the segment is its own <button> in the Build pill, not nested in the Build button",
        await chip.evaluate((el) => ({
          tag: el.tagName,
          inButton: el.parentElement?.closest("button") != null,
          inGroup: el.closest('[data-slot="button-group"]') != null,
        })),
        { tag: "BUTTON", inButton: false, inGroup: true },
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

    const dot = statusDot(page);
    const dotClass =
      (await dot.count()) > 0
        ? ((await dot.getAttribute("class")) ?? "")
        : "<no dot>";
    r.ok(
      "deferred failure: the action-bar status dot is red",
      dotClass.includes("bg-destructive"),
      dotClass,
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
    await breakArtifact(page, eager.url);
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
