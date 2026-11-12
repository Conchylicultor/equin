/**
 * Prototypes runs in the demo, on the demo's own seeded files
 * (research/2026-10-24-global-data-files-host-service.md, Verification): its
 * tree is a memory `data-files` root in the browser worker, its frames are
 * served by the host's Service Worker under `/artifacts/<host>/frames/`, its
 * history is the snapshot store, its thumbnails the committed PNGs.
 *
 * In `/demo` it:
 *
 *  1. opens Prototypes through the embed's launcher: the gallery lists the
 *     six seeded prototypes, each card's real thumbnail loaded;
 *  2. opens Family Recipes' canvas: frame A's document is served under the
 *     frames scope and runs its app — the recipe cards render, each photo
 *     loaded from the `photos.js` beside it; the user's seeded pick (accent
 *     terracotta) is painted;
 *  3. picks another accent: the frame repaints, no reload;
 *  4. steps frame A back through its history to `v0`: the frame loads a `/versions/<sha>/`
 *     document (no week bar — `v1` added it);
 *  5. makes `v0` the latest (restore): a new version is recorded, the live
 *     frame shows it, and back in the gallery its card's thumbnail still loads
 *     (the restored folder has `v0`'s fingerprint: a cache hit);
 *  6. opens the app-mocking prototype (Miller columns): its counterpart
 *     answers `unresolved` (the app needs serving by URL), so the canvas
 *     offers no Real app frame; the exhibit-mocking one's (Menu) Real app
 *     frame renders the exhibit in-process;
 *  7. a frame URL the Service Worker does not answer is a 404 at the gateway,
 *     never the app's shell.
 *
 * And throughout: the page stays on the demo, no `/api/…` request left for the
 * page's origin (sanctioned telemetry aside — `no-leak.ts`'s list), every
 * frame `src` is under `/artifacts/*\/frames/`, no page or console error.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/demo/e2e/prototypes-in-demo.ts [--out /tmp/demo-prototypes] [--headed]
 */
import type { Frame, Locator, Page, Request } from "playwright";
import {
  agentFetch,
  arg,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
  type Settled,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  addSource,
  card,
  dismiss,
  frameColor,
  listFrames,
  openOptions,
  pickValue,
  screen,
  setLayout,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/e2e";
import {
  canvasFrameSelector,
  compareWithLabel,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/core";
import { REAL_APP_LABEL } from "@plugins/apps/plugins/prototypes/plugins/compare/core";
import { pickFromLauncher } from "@plugins/apps-core/plugins/app-launcher/e2e";
import {
  AGENT_MANAGER_LOCATION,
  demoPath,
  onDemoPage,
  bootDemo,
} from "./internal/demo-pages";

const OUT = arg("out") ?? "/tmp/demo-prototypes";

/** The page-origin `/api` routes a demo may still call — `no-leak.ts`'s list (D3). */
const SANCTIONED: readonly RegExp[] = [
  /^\/api\/logs\/emit$/,
  /^\/api\/latency-ledger\/client$/,
  /^\/api\/slow-ops\/client$/,
  /^\/api\/app-usage\/flush$/,
  /^\/api\/analytics\/collect$/,
  /^\/api\/reports$/,
  /^\/api\/icons\/(sprite|symbols)\//,
  /^\/api\/health(\/ready)?$/,
];

/** The seeded prototypes (`website/demos/workspace`'s `data/prototypes/`). */
const RECIPES = { id: "proto-1792900000-demo01", title: "Family Recipes" };
/** The one that mocks the real app at a route, and the one that mocks an exhibit. */
const MILLER = { title: "Miller columns" };
const MENU = { title: "Menu" };
const TITLES = [
  RECIPES.title,
  "Bridge Trainer",
  "Circle — P2P friends",
  MENU.title,
  "Tree table",
  MILLER.title,
];
/** The seeded pick, and the value the flow picks instead. */
const SEEDED_ACCENT = "#c8553d";
const PICKED_ACCENT = { label: "Ocean", color: "#2f6f8f" };
/** A frame src the host's Service Worker serves: `/artifacts/<host>/frames/<server>/api/…`. */
const FRAME_SRC_RE = /^\/artifacts\/[^/]+\/frames\/[^/]+\/api\/prototypes\//;
const RENDER_TIMEOUT_MS = 20_000;

function embedRoot(page: Page): Locator {
  return page.locator("[data-app-embed]").first();
}

/** Frame A's live document (the iframe on screen), once it has loaded. */
async function frameOf(page: Page, letter: string): Promise<Frame | null> {
  const iframe = screen(page, letter).locator("iframe:not([aria-hidden])");
  if ((await iframe.count()) !== 1) return null;
  const handle = await iframe.elementHandle();
  return handle ? handle.contentFrame() : null;
}

/** Frame `letter`'s iframe `src`, path and query (`""` while it has none). */
async function frameSrc(page: Page, letter: string): Promise<string> {
  const iframe = screen(page, letter).locator("iframe:not([aria-hidden])");
  if ((await iframe.count()) !== 1) return "";
  const src = (await iframe.getAttribute("src")) ?? "";
  const url = new URL(src, page.url());
  return `${url.pathname}${url.search}`;
}

/** What Family Recipes' document shows: its cards, their photos, the week bar. */
async function frameLooks(frame: Frame): Promise<{
  title: string;
  gridDisplay: string;
  cards: number;
  photosLoaded: number;
  weekBar: boolean;
}> {
  return frame.evaluate(() => {
    const photos = [
      ...document.querySelectorAll<HTMLImageElement>(".card img"),
    ];
    return {
      title: document.title,
      gridDisplay: getComputedStyle(
        document.querySelector(".grid") ?? document.body,
      ).display,
      cards: document.querySelectorAll(".card").length,
      photosLoaded: photos.filter(
        (img) =>
          img.complete && img.naturalWidth > 0 && img.src.startsWith("data:"),
      ).length,
      weekBar: document.querySelector(".pill") !== null,
    };
  });
}

/** The gallery card of the prototype titled `title`. */
function galleryCard(page: Page, title: string): Locator {
  return embedRoot(page)
    .locator("[data-row-key]")
    .filter({ hasText: title })
    .first();
}

/** Whether the gallery card's cover image has loaded a real picture. */
async function thumbnailLoaded(page: Page, title: string): Promise<boolean> {
  const img = galleryCard(page, title).locator("img").first();
  if ((await img.count()) === 0) return false;
  return img.evaluate(
    (el) =>
      (el as HTMLImageElement).complete &&
      (el as HTMLImageElement).naturalWidth > 0,
  );
}

await withBrowser(async (h) => {
  const r = report("demo: Prototypes on the demo's own files");
  const { page, captured } = await h.session({
    viewport: { width: 1600, height: 1000 },
  });

  await bootDemo(page, pathUrl(demoPath(AGENT_MANAGER_LOCATION)), {
    marker: 'button:has-text("Conversations")',
  });
  await page
    .getByRole("button", { name: "Tasks", exact: true })
    .first()
    .waitFor();

  const leaked: string[] = [];
  const onRequest = (req: Request): void => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return;
    if (!SANCTIONED.some((re) => re.test(url.pathname)))
      leaked.push(`${req.method()} ${url.pathname}`);
  };
  page.on("request", onRequest);
  const frameSrcs = new Set<string>();
  const noteFrames = async (): Promise<void> => {
    for (const src of await page
      .locator(`${canvasFrameSelector()} iframe`)
      .evaluateAll((els) => els.map((el) => el.getAttribute("src") ?? "")))
      if (src !== "") frameSrcs.add(new URL(src, page.url()).pathname);
  };

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

  // ── 1. the gallery ──────────────────────────────────────────────────────
  r.ok(
    "the launcher offers Prototypes",
    await pickFromLauncher(embedRoot(page), /Prototypes/),
  );
  await renders(
    "the embed switches to Prototypes",
    () => embedRoot(page).getAttribute("data-app-embed"),
    (id) => id === "prototypes",
  );
  for (const title of TITLES)
    await renders(
      `the gallery shows "${title}" with its real thumbnail`,
      () => thumbnailLoaded(page, title),
      (loaded) => loaded,
    );
  await snap(page, OUT, "1-gallery");

  // ── 2. Family Recipes' canvas ──────────────────────────────────────────
  await galleryCard(page, RECIPES.title).click();
  await renders(
    "the canvas opens on frame A",
    () =>
      page
        .locator(canvasFrameSelector({ letter: "A", status: "found" }))
        .count(),
    (n) => n > 0,
  );
  await renders(
    "frame A's document is served under the host's frames scope",
    () => frameSrc(page, "A"),
    (src) => FRAME_SRC_RE.test(src) && src.includes(RECIPES.id),
  );
  const looks = await renders(
    "frame A runs its app: the recipe cards, each photo loaded from its photos.js",
    async () => {
      const frame = await frameOf(page, "A");
      return frame ? frameLooks(frame) : null;
    },
    (l) =>
      l !== null &&
      l.title === RECIPES.title &&
      l.gridDisplay === "grid" &&
      l.cards > 0 &&
      l.photosLoaded === l.cards &&
      l.weekBar,
  );
  r.note(`frame A: ${JSON.stringify(looks.value)}`);
  await renders(
    `frame A paints the seeded pick (accent ${SEEDED_ACCENT})`,
    () => frameColor(page, "A", "accent"),
    (c) => c === SEEDED_ACCENT,
  );
  await noteFrames();
  await snap(page, OUT, "2-canvas");

  // ── 3. a color pick repaints ────────────────────────────────────────────
  await setLayout(page, "side");
  const srcBefore = await frameSrc(page, "A");
  const popover = await openOptions(page, "A");
  r.eq(
    "the latest version offers every option it declares",
    await Promise.all(
      ["Cards", "Headings", "Accent", "Paper"].map((label) =>
        popover.getByRole("radiogroup", { name: label }).count(),
      ),
    ),
    [1, 1, 1, 1],
  );
  await pickValue(popover, "Accent", PICKED_ACCENT.label);
  await dismiss(page);
  await renders(
    `picking accent ${PICKED_ACCENT.label} repaints frame A`,
    () => frameColor(page, "A", "accent"),
    (c) => c === PICKED_ACCENT.color,
  );
  r.eq("…without reloading its document", await frameSrc(page, "A"), srcBefore);

  // ── 4. the version stepper ──────────────────────────────────────────────
  const stepper = card(page, "A").getByRole("group", { name: "Version" });
  const prev = stepper.getByRole("button", { name: "Previous version" });
  await prev.waitFor({ state: "visible", timeout: RENDER_TIMEOUT_MS });
  await prev.click();
  await renders(
    "‹ steps frame A to a recorded version, served under the frames scope",
    () => frameSrc(page, "A"),
    (src) => FRAME_SRC_RE.test(src) && /\/versions\/[0-9a-f]+\//.test(src),
  );
  // Back to the first version, however many steps the history has.
  while (await prev.isEnabled()) await prev.click();
  const v0 = await renders(
    "‹ to the start: v0's document (cards, no week bar — v1 added it)",
    async () => {
      const frame = await frameOf(page, "A");
      return frame ? frameLooks(frame) : null;
    },
    (l) => l !== null && l.cards > 0 && !l.weekBar,
  );
  r.note(`v0: ${JSON.stringify(v0.value)}`);
  await noteFrames();
  await snap(page, OUT, "4-v0");

  // ── 5. restore v0 ───────────────────────────────────────────────────────
  await stepper.getByRole("button").filter({ hasText: /^v0/ }).first().click();
  await page.getByRole("button", { name: /Make v0 the latest/ }).click();
  await page.getByRole("button", { name: "Make it the latest" }).click();
  await renders(
    "restoring v0 records a version",
    () => page.getByText("Restored v0").count(),
    (n) => n > 0,
  );
  await renders(
    "…and the live frame shows it",
    async () => {
      const src = await frameSrc(page, "A");
      const frame = await frameOf(page, "A");
      return frame && !src.includes("/versions/") ? frameLooks(frame) : null;
    },
    (l) => l !== null && l.cards > 0 && !l.weekBar,
  );
  await noteFrames();
  await snap(page, OUT, "5-restored");

  // Back to the gallery: the restored folder is v0's bytes, whose PNG is seeded.
  await pickFromLauncher(embedRoot(page), /Prototypes/);
  await renders(
    "the restored prototype's thumbnail is a cache hit",
    () => thumbnailLoaded(page, RECIPES.title),
    (loaded) => loaded,
  );
  r.eq(
    "…not the unavailable marker",
    await galleryCard(page, RECIPES.title)
      .getByText("Preview unavailable")
      .count(),
    0,
  );

  // ── 6. compare: an app counterpart unresolved, an exhibit in-process ────
  await galleryCard(page, MILLER.title).click();
  await renders(
    "the app-mocking prototype's canvas opens",
    () =>
      page
        .locator(canvasFrameSelector({ letter: "A", status: "found" }))
        .count(),
    (n) => n > 0,
  );
  const compareButton = page.getByRole("button", {
    name: compareWithLabel(REAL_APP_LABEL),
    exact: true,
  });
  // The rail offers a source only once it resolves; give it the time a
  // resolving one takes (Menu's, below, shows within it).
  await page.waitForTimeout(3_000);
  r.eq(
    "its app: counterpart answers unresolved here (the app needs serving by URL), so the rail offers no Real app frame",
    await compareButton.count(),
    0,
  );
  r.eq(
    "…and the canvas draws no iframe of the page's app",
    await page.locator(`${canvasFrameSelector()} iframe`).count(),
    1,
  );
  await noteFrames();
  await snap(page, OUT, "6-compare-app");

  await pickFromLauncher(embedRoot(page), /Prototypes/);
  await galleryCard(page, MENU.title).click();
  await addSource(page, REAL_APP_LABEL);
  await renders(
    "the exhibit-mocking prototype's Real app frame renders the exhibit in-process",
    async () =>
      (await listFrames(page)).map((f) => `${f.letter}:${f.kind}:${f.status}`),
    (frames) => frames.some((f) => f === "B:real-app:found"),
  );
  await noteFrames();
  await snap(page, OUT, "6-compare-exhibit");

  // ── 7. a frame URL nothing serves is a 404, not the app ─────────────────
  const [anySrc] = [...frameSrcs];
  if (anySrc === undefined) r.fail("a frame src was seen", "none");
  else {
    const stale = anySrc.replace(
      /\/frames\/[^/]+\//,
      "/frames/no-such-server/",
    );
    const res = await agentFetch(stale);
    const body = await res.text();
    r.ok(
      `${stale} (no Service Worker in front) is a 404 at the gateway, not the app`,
      res.status === 404 && !body.includes('<div id="root"'),
      `${res.status} ${body.slice(0, 80)}`,
    );
  }

  page.off("request", onRequest);

  // ── assertions ──────────────────────────────────────────────────────────
  r.ok("the page stays on the demo", onDemoPage(page.url()), page.url());
  r.eq(
    "no /api request left for the page's origin (sanctioned telemetry aside)",
    leaked,
    [],
  );
  r.ok(
    "every frame src is under /artifacts/*/frames/",
    frameSrcs.size > 0 && [...frameSrcs].every((s) => FRAME_SRC_RE.test(s)),
    [...frameSrcs].join("\n  "),
  );
  r.eq("no page errors", captured.pageErrors, []);
  r.eq("no console errors", captured.consoleErrors, []);
  await r.finish();
});
