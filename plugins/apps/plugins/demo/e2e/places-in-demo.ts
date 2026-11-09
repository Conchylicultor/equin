/**
 * Places runs in the demo on the browser worker
 * (research/2026-11-06-global-places-in-browser-demo.md, Verification).
 *
 * In `/demo`, it:
 *
 *  1. opens the launcher inside the embed and picks Places: the embed switches
 *     to Places, whose header counts the demo's few hundred places (Demo's
 *     Paris and their trips) and whose tag sidebar holds Demo's own "Lisbon"
 *     tag (`website/demos/workspace`'s `core/internal/places.ts`), read from
 *     the worker; the place and tag
 *     icons are the demo's own saved icons, in its own sheet;
 *  2. draws the map: when this instance has a Maps browser key, Google's map
 *     draws in the embed (its script and tiles loaded from Google, with the
 *     key the page's chrome handed the worker — the demo's code never reads
 *     the page's server); without one, the map's set-up state says setting it
 *     up is not available here;
 *  2b. opens on Paris, where most of the places are (the map's densest-area
 *     opening), not on the world its trips span;
 *  2c. picks each of Demo's saved presets (Want to go in Paris, Favorites,
 *     Cheap eats): the side panel counts the places it shows ("All N"); back
 *     to All places;
 *  3. opens a place's card ("Castelo de São Jorge", through the search bar): Google's details and the
 *     icon pick say "not available", never a set-up prompt;
 *  3b. opens the Lisbon tag's icon picker (its ⋯ in the sidebar's tag tree): its grid draws
 *     from the demo's own icon sheet (the worker's bundled set), and the
 *     picked icon draws on the tag;
 *  4. types in the search bar: the Google half says searching is not
 *     available;
 *  5. switches the embed to the Desktop, opens Places as a window from the
 *     shelf's launcher, takes it full screen, and comes back with Esc.
 *
 * And asserts, throughout, that nothing left the scope — the list `no-leak.ts`
 * checks against (D3): no `/api/…` request for the page's origin but the
 * sanctioned telemetry routes (the icons included — no exception), no page socket, no page or console error — and
 * that every request to another origin, the page's or the worker's, goes to a
 * host a scoped plugin declares (`externalHosts`, `ExternalHosts.Declare`).
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/demo/e2e/places-in-demo.ts [--out /tmp/demo-places] [--headed]
 */
import type { Locator, Page, Request, WebSocket } from "playwright";
import { pickFromLauncher } from "@plugins/apps-core/plugins/app-launcher/e2e";
import {
  DEMO_PLACES,
  externalHosts,
} from "@plugins/apps/plugins/website/plugins/demos/plugins/workspace/core";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  tapSharedWorkerRequests,
  waitFor,
  waitForNetworkIdle,
  withBrowser,
  type Settled,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  AGENT_MANAGER_LOCATION,
  demoPath,
  onDemoPage,
} from "./internal/demo-pages";

const OUT = arg("out") ?? "/tmp/demo-places";

/** The page-origin `/api` routes a demo may still call — `no-leak.ts`'s list (D3). */
const SANCTIONED: readonly RegExp[] = [
  /^\/api\/logs\/emit$/,
  /^\/api\/latency-ledger\/client$/,
  /^\/api\/slow-ops\/client$/,
  /^\/api\/app-usage\/flush$/,
  /^\/api\/analytics\/collect$/,
  /^\/api\/reports$/,
  /^\/api\/health(\/ready)?$/,
];

/** The demo's places (`core/internal/places.ts`). */
const PLACE_COUNT = DEMO_PLACES.places.length;
/** Whether `p` carries `path` or a tag nested under it (the sidebar's `has-nested`). */
const taggedUnder = (
  p: (typeof DEMO_PLACES.places)[number],
  path: readonly string[],
) => p.tags.some((t) => path.every((segment, k) => t[k] === segment));
/** The trips' places, which a map opened on Paris leaves off screen. */
const TRIP_NAMES = new Set(
  DEMO_PLACES.places
    .filter((p) => p.tags.some((t) => t[0] === "Trips"))
    .map((p) => p.place.name),
);
/** Demo's saved presets, with how many places each shows (its tag filter: has-nested rows, lacks-nested). */
const PRESETS = (DEMO_PLACES.presets ?? []).map((preset) => ({
  name: preset.name,
  count: DEMO_PLACES.places.filter(
    (p) =>
      preset.tagged.every((row) => row.some((path) => taggedUnder(p, path))) &&
      !(preset.notTagged ?? []).some((path) => taggedUnder(p, path)),
  ).length,
}));
const PLACE = "Castelo de São Jorge";
/** How long an app swap, a worker read or the map gets. */
const RENDER_TIMEOUT_MS = 30_000;
/**
 * Google's own console error when it cannot draw the vector map (headless
 * Chromium has no WebGL for it): it falls back to the raster map, which is
 * what the page shows. Counted apart, never as a failure — a real browser
 * draws the vector map.
 */
const GOOGLE_RASTER_FALLBACK =
  /^Attempted to load a Vector Map, but failed\. Falling back to Raster/;

/** The one sentence every "not available" says (`unavailableMessage`). */
const NOT_AVAILABLE = /isn't available in this version of the app/;

function embedRoot(page: Page): Locator {
  return page.locator("[data-app-embed]").first();
}

/** The distinct windows (one titlebar tab strip each) inside `root`. */
async function windowIds(root: Locator): Promise<string[]> {
  const ids = await root
    .locator("[data-floating-window-id]")
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-floating-window-id") ?? ""),
    );
  return [...new Set(ids)].sort();
}

await withBrowser(async (h) => {
  const r = report("demo: Places on the browser worker");
  const worker = await tapSharedWorkerRequests(h.browser);
  const { page, captured } = await h.session({
    viewport: { width: 1440, height: 900 },
  });

  await boot(page, pathUrl(demoPath(AGENT_MANAGER_LOCATION)), {
    marker: 'button:has-text("Conversations")',
  });
  await waitForNetworkIdle(page);
  const origin = new URL(page.url()).origin;
  const declared = new Set(externalHosts.map((h) => h.host));

  const leaked: string[] = [];
  const offOrigin: string[] = [];
  const onRequest = (req: Request): void => {
    const url = new URL(req.url());
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (url.origin !== origin) {
      offOrigin.push(url.host);
      return;
    }
    if (!url.pathname.startsWith("/api/")) return;
    const line = `${req.method()} ${url.pathname}`;
    if (!SANCTIONED.some((re) => re.test(url.pathname))) leaked.push(line);
  };
  page.on("request", onRequest);
  const openedSockets: string[] = [];
  const onSocket = (ws: WebSocket): void => {
    openedSockets.push(new URL(ws.url()).pathname);
  };
  page.on("websocket", onSocket);

  const renders = async <T>(
    name: string,
    read: () => Promise<T>,
    ok: (value: T) => boolean,
  ): Promise<Settled<T>> => {
    const settled = await waitFor(read, ok, { timeoutMs: RENDER_TIMEOUT_MS });
    r.ok(
      name,
      settled.ok,
      `${JSON.stringify(settled.value)} (waited ${settled.waitedMs} ms)`,
    );
    return settled;
  };

  // ── 1. launcher → Places: the places and tags from the worker ───────────
  r.ok(
    "the launcher offers Places",
    await pickFromLauncher(embedRoot(page), /^\s*Places\s*$/),
  );
  await renders(
    "the embed switches to Places",
    () => embedRoot(page).getAttribute("data-app-embed"),
    (id) => id === "places",
  );
  await renders(
    `the sidebar counts the demo's ${PLACE_COUNT} places`,
    () =>
      embedRoot(page).getByText(String(PLACE_COUNT), { exact: true }).count(),
    (n) => n > 0,
  );
  await renders(
    "the tag tree holds Demo's Lisbon tag",
    () => embedRoot(page).getByText("Lisbon", { exact: true }).count(),
    (n) => n > 0,
  );
  r.ok("the page stays on the demo", onDemoPage(page.url()), page.url());

  // ── 1b. saved icons: the demo's own, drawn from the worker ──────────────
  // A place's icon (Demo's castle) and a tag's are saved icons: the scope's
  // own sheet holds them (resident: the worker's saved-icon sources report
  // them), and no icon in the embed draws from the page's sheet.
  await renders(
    "the demo's own icon sheet holds a place's icon (castle)",
    () =>
      page
        .locator("[data-runtime-symbol-sheet] symbol[id$='-400-castle']")
        .count(),
    (n) => n > 0,
  );
  r.eq(
    "no saved icon in the embed draws from the page's sheet",
    await embedRoot(page).locator("use[href^='#msr-']").count(),
    0,
  );

  // ── 2. the map: Google's, with the key the page handed over ─────────────
  const map = await renders(
    "the map draws Google's map, or says setting it up is not available",
    async () =>
      (await embedRoot(page).locator(".gm-style").count()) > 0
        ? "google"
        : (await embedRoot(page).getByText(NOT_AVAILABLE).count()) > 0
          ? "not-available"
          : null,
    (v) => v !== null,
  );
  r.note(`map: ${map.value ?? "none"}`);
  if (map.value === "google") {
    await renders(
      "Google's tiles loaded from Google",
      async () => offOrigin.filter((host) => host.endsWith("googleapis.com")),
      (hosts) => hosts.length > 0,
    );
  }
  await page.waitForTimeout(3_000);
  await snap(page, OUT, "1-map");

  // ── 2b. it opens on Paris, where most of Demo's places are ──────────────
  // A first visit frames the densest area (the map's `opening: "densest"`),
  // not every place: Demo's trips span the world, Paris is where they live.
  if (map.value === "google") {
    // The side panel's "In view" counts the places the camera shows: every
    // place but the trips'.
    await renders(
      `the map opens on Paris: ${PLACE_COUNT - TRIP_NAMES.size} places in view, no trip's`,
      () =>
        embedRoot(page)
          .getByText(`In view ${PLACE_COUNT - TRIP_NAMES.size}`, {
            exact: true,
          })
          .count(),
      (n) => n > 0,
    );
  }

  // ── 2c. Demo's saved presets: each narrows the map ──────────────────────
  for (const preset of PRESETS) {
    await embedRoot(page)
      .getByText(preset.name, { exact: true })
      .first()
      .click();
    await renders(
      `the "${preset.name}" preset shows its ${preset.count} of ${PLACE_COUNT} places`,
      () =>
        embedRoot(page)
          .getByText(`All ${preset.count}`, { exact: true })
          .count(),
      (n) => n > 0,
    );
  }
  await snap(page, OUT, "1b-preset");
  await embedRoot(page)
    .getByText("All places", { exact: true })
    .first()
    .click();
  await renders(
    "All places shows every place again",
    () =>
      embedRoot(page).getByText(`All ${PLACE_COUNT}`, { exact: true }).count(),
    (n) => n > 0,
  );

  // ── 3. a place's card: details and the icon pick are not available ─────
  // Through the search bar's "Your places": the side panel lists what is in
  // view, and the map opened on Paris.
  const find = embedRoot(page).getByPlaceholder("Search or add places");
  await find.click();
  await find.fill(PLACE);
  await page.getByText(PLACE, { exact: true }).first().click();
  await renders(
    `the card opens on "${PLACE}"`,
    () => embedRoot(page).getByLabel("Note", { exact: true }).count(),
    (n) => n > 0,
  );
  await renders(
    "Google's details say they are not available here",
    () =>
      embedRoot(page)
        .getByText(/Reading Google's details of a place isn't available/)
        .count(),
    (n) => n > 0,
  );
  await renders(
    "the icon pick says it is not available here",
    () =>
      embedRoot(page)
        .getByText(/Picking a place's icon isn't available/)
        .count(),
    (n) => n > 0,
  );
  r.eq(
    "no set-up prompt for the visitor",
    await embedRoot(page)
      .getByRole("button", { name: /Set up Google Maps/ })
      .count(),
    0,
  );
  await snap(page, OUT, "2-card");
  await page.keyboard.press("Escape");

  // ── 3b. a tag's icon: the picker draws from the worker, and a pick sticks ─
  const lisbon = embedRoot(page)
    .locator("[data-tag-picker] [data-tree-id]")
    .filter({ hasText: "Lisbon" })
    .first();
  await lisbon.hover();
  await lisbon.getByRole("button", { name: "More", exact: true }).click();
  // The menu is portalled out of the embed (still in the scope).
  await page.getByRole("menuitem", { name: "Icon…" }).click();
  // The picker is a popover, portalled out of the embed (still in the scope).
  const grid = await renders(
    "the icon picker's grid draws its icons from the demo's own sheet",
    () => page.locator("button[aria-pressed] use[href^='#rs']").count(),
    (n) => n > 20,
  );
  r.note(`picker cells drawn: ${grid.value ?? 0}`);
  await page.getByPlaceholder("Search icons…").fill("sailing");
  await page
    .getByRole("button", { name: /^sailing$/i })
    .first()
    .click();
  await renders(
    "the picked icon draws on the tag, from the demo's own sheet",
    () => lisbon.locator("use[href*='msr-'][href$='-sailing']").count(),
    (n) => n > 0,
  );
  await snap(page, OUT, "2b-tag-icon");
  await page.keyboard.press("Escape");

  // ── 4. search: Google's half is not available ───────────────────────────
  const search = embedRoot(page).getByPlaceholder("Search or add places");
  await search.click();
  await search.fill("Pastéis");
  // The suggestions panel is a popover, portalled out of the embed.
  await renders(
    "the search's Google half says searching is not available",
    () => page.getByText(/Searching Google Places isn't available/).count(),
    (n) => n > 0,
  );
  await renders(
    "the search still finds Demo's own place",
    () => page.getByText("Pastéis de Belém", { exact: true }).count(),
    (n) => n > 0,
  );
  await snap(page, OUT, "3-search");
  await search.fill("");
  await page.keyboard.press("Escape");

  // ── 5. the Desktop: Places as a window, then full screen ────────────────
  r.ok(
    "the launcher offers Desktop",
    await pickFromLauncher(embedRoot(page), /^\s*Desktop\s*$/),
  );
  await renders(
    "the embed is a desktop",
    () => windowIds(embedRoot(page)),
    (ids) => ids.length >= 1,
  );
  r.ok(
    "the launcher offers Places on the desktop",
    await pickFromLauncher(embedRoot(page), /^\s*Places\s*$/),
  );
  await renders(
    "Places shows in a window",
    () => windowIds(embedRoot(page)),
    (ids) => ids.length >= 1,
  );
  await renders(
    "the window shows Demo's places",
    () => embedRoot(page).getByText("Lisbon", { exact: true }).count(),
    (n) => n > 0,
  );
  await snap(page, OUT, "4-window");
  await embedRoot(page)
    .getByRole("button", { name: "Full screen" })
    .last()
    .click();
  await renders(
    "Full screen leaves no window: Places fills the embed",
    () => windowIds(embedRoot(page)),
    (ids) => ids.length === 0,
  );
  await renders(
    "the full-screen Places still shows its places",
    () => embedRoot(page).getByText("Lisbon", { exact: true }).count(),
    (n) => n > 0,
  );
  await snap(page, OUT, "5-full-screen");
  await page.keyboard.press("Escape");
  await renders(
    "Esc returns to the desktop",
    () => windowIds(embedRoot(page)),
    (ids) => ids.length >= 1,
  );
  r.ok("the page stays on the demo", onDemoPage(page.url()), page.url());

  page.off("request", onRequest);
  page.off("websocket", onSocket);

  // ── assertions ──────────────────────────────────────────────────────────
  r.eq(
    "no /api request left for the page's origin (sanctioned telemetry aside)",
    leaked,
    [],
  );
  r.eq("the page opened no socket of its own", openedSockets, []);
  const workerHosts = worker.requests
    .map((req) => new URL(req.url))
    .filter((url) => url.origin !== origin && url.protocol.startsWith("http"))
    .map((url) => url.host);
  const reached = [...new Set([...offOrigin, ...workerHosts])].sort();
  r.note(`third-party hosts reached: ${reached.join(", ") || "none"}`);
  r.eq(
    "every third-party host reached is declared (ExternalHosts.Declare)",
    reached.filter((host) => !declared.has(host)),
    [],
  );
  r.eq("no page errors", captured.pageErrors, []);
  const fallback = captured.consoleErrors.filter((e) =>
    GOOGLE_RASTER_FALLBACK.test(e),
  );
  if (fallback.length > 0)
    r.note(
      `Google fell back to the raster map ${fallback.length}× (no WebGL here)`,
    );
  r.eq(
    "no console errors",
    captured.consoleErrors.filter((e) => !GOOGLE_RASTER_FALLBACK.test(e)),
    [],
  );
  await worker.release();
  await r.finish();
});
