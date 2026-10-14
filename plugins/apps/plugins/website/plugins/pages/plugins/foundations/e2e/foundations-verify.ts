// Verifies the Foundations iceberg (`/website/foundations`) against its mock
// (`proto-1790334655-cs0c`, at its picked options: header sticky, split icon):
// the behaviour a pixel diff at rest cannot see.
//
//   - the sky fills exactly the first screen of the pane (the waterline lands
//     at its bottom edge) and the header rests on it in dark ink;
//   - the gauge reads "Sea level", then counts the lines below the surface, and
//     the whole count at the very bottom;
//   - a Harness piece carries its teal wrench, and is otherwise a plain chip;
//   - the header stays pinned: frosted in dark ink over the sky, frosted in
//     light ink over the water, and a gauge jump lands the layer just below it;
//   - a piece opens in place into its card (the drawing mounted), its top edge
//     held still, and folds back (the drawing gone);
//   - the Components / Harness key dims the other half;
//   - `E` opens every piece (every drawing mounted) and closes them all again;
//   - each card is photographed open, one file per card, for a side-by-side
//     pass against the prototype's gallery.
//
// Usage:
//   ./singularity run plugins/apps/plugins/website/plugins/pages/plugins/foundations/e2e/foundations-verify.ts \
//     [--out /tmp/foundations] [--width 1280] [--height 900] [--color-scheme dark|light] [--headed]
//
// Manual only — nothing runs this automatically.

import type { Page } from "playwright";
import {
  arg,
  boot,
  numArg,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/foundations");
const width = numArg("width", 1280);
const height = numArg("height", 900);
const colorScheme = arg("color-scheme", "dark") === "light" ? "light" : "dark";

/** Pieces and drawings on the page (data.ts / cards/index.ts). */
const PIECES = 60;
const CARDS = 32;

interface SceneState {
  open: number;
  mounted: number;
  readout: string;
  waterTop: number;
  screen: number;
  scrollTop: number;
}

async function sceneState(page: Page): Promise<SceneState> {
  return page.evaluate(() => {
    const scene = document.querySelector<HTMLElement>(".iceberg-scene");
    const water = document.querySelector<HTMLElement>(
      '.iceberg-layer[data-i="1"]',
    );
    let scroller: HTMLElement | null = scene?.parentElement ?? null;
    while (
      scroller &&
      !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
    )
      scroller = scroller.parentElement;
    const sr = scroller?.getBoundingClientRect();
    return {
      open: document.querySelectorAll(".iceberg-item.open:not(.ghost)").length,
      mounted: document.querySelectorAll(
        ".iceberg-item:not(.ghost) .vz .k-root",
      ).length,
      readout: document.querySelector(".iceberg-readout")?.textContent ?? "",
      waterTop: (water?.getBoundingClientRect().top ?? 0) - (sr?.top ?? 0),
      screen: scroller?.clientHeight ?? 0,
      scrollTop: scroller?.scrollTop ?? 0,
    };
  });
}

/** Scroll the pane to its top (the hero) or its very bottom (the site footer). */
async function scrollPane(page: Page, to: "top" | "bottom"): Promise<void> {
  await (
    to === "top" ? page.locator(".iceberg-hero") : page.locator("footer").last()
  ).scrollIntoViewIfNeeded();
}

/** The site header's Story link colour, and the pinned bar's backdrop filter and top / bottom edges. */
async function headerState(page: Page) {
  return page.evaluate(() => {
    const story = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Story",
    );
    let bar: HTMLElement | null = story ?? null;
    while (bar && getComputedStyle(bar).position !== "sticky")
      bar = bar.parentElement;
    const r = bar?.getBoundingClientRect();
    return {
      ink: story ? getComputedStyle(story).color : "",
      filter: bar ? getComputedStyle(bar).backdropFilter : "",
      top: r?.top ?? -1,
      bottom: r?.bottom ?? -1,
    };
  });
}

const piece = (page: Page, name: string) =>
  page.locator("button.iceberg-item:not(.ghost)", { hasText: name }).first();

await withBrowser(async (h) => {
  const r = report("foundations iceberg");
  const { page } = await h.session({
    viewport: { width, height },
    colorScheme,
  });
  await boot(page, pathUrl("/website/foundations"), {
    marker: "text=Descend ↓",
    settleMs: 1200,
  });

  // --- the first screen is all sky --------------------------------------------
  const top = await sceneState(page);
  r.ok(
    "the waterline lands at the bottom of the first screen",
    Math.abs(top.waterTop - top.screen) <= 2,
    `water at ${top.waterTop}px, screen ${top.screen}px`,
  );
  r.ok(
    "the gauge reads sea level",
    top.readout.startsWith("Sea level"),
    top.readout,
  );
  const headerInk = await page.evaluate(() => {
    const story = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Story",
    );
    return story ? getComputedStyle(story).color : "";
  });
  r.ok(
    "at rest over the sky, the header's links are in the sky's dark ink",
    /rgb\(60, 72, 88\)|#3c4858/i.test(headerInk),
    headerInk,
  );
  await snap(page, out, "top");

  // --- the Harness mark (split: icon) -------------------------------------------
  const mark = await page.evaluate(() => {
    const m = document.querySelector<HTMLElement>(
      '.iceberg-item:not(.ghost)[data-kind="harness"] .iceberg-mark',
    );
    const item = m?.closest<HTMLElement>(".iceberg-item");
    return m && item
      ? {
          display: getComputedStyle(m).display,
          color: getComputedStyle(m).color,
          itemBg: getComputedStyle(item).backgroundColor,
        }
      : null;
  });
  r.ok(
    "a Harness piece carries the teal wrench on a plain chip",
    mark !== null &&
      mark.display !== "none" &&
      mark.color === "rgb(8, 145, 178)" &&
      mark.itemBg === "rgb(255, 255, 255)",
    JSON.stringify(mark),
  );

  // --- the pinned header ----------------------------------------------------------
  await page.locator('.iceberg-gauge a[data-i="0"]').click();
  await page.waitForTimeout(500);
  const overSky = await headerState(page);
  r.ok(
    "over the sky, the pinned header is frosted in the sky's dark ink",
    overSky.top === 0 &&
      overSky.filter.includes("blur") &&
      /rgb\(60, 72, 88\)/.test(overSky.ink),
    JSON.stringify(overSky),
  );
  await page.locator('.iceberg-gauge a[data-i="3"]').click();
  const overSea = await waitFor(
    () => headerState(page),
    (h) => /rgb\(180, 180, 189\)/.test(h.ink),
    { timeoutMs: 3000, intervalMs: 100 },
  );
  r.ok(
    "over the water, the pinned header is frosted in light ink",
    overSea.ok &&
      overSea.value.top === 0 &&
      overSea.value.filter.includes("blur"),
    JSON.stringify(overSea.value),
  );
  const landed = await page.evaluate(
    () =>
      document
        .querySelector('.iceberg-layer[data-i="3"]')
        ?.getBoundingClientRect().top ?? -1,
  );
  r.ok(
    "a gauge jump lands the layer just below the pinned header",
    Math.abs(landed - overSea.value.bottom) <= 2,
    `layer at ${landed}px, header bottom ${overSea.value.bottom}px`,
  );
  await snap(page, out, "header-deep");
  await scrollPane(page, "top");

  // --- a piece opens in place, and folds back -----------------------------------
  const target = piece(page, "Windowed loading");
  await target.scrollIntoViewIfNeeded();
  const before = (await target.boundingBox())?.y ?? 0;
  await target.click({ position: { x: 12, y: 8 } });
  const opened = await waitFor(
    () => sceneState(page),
    (s) => s.open === 1 && s.mounted === 1,
    { timeoutMs: 3000, intervalMs: 100 },
  );
  r.ok(
    "clicking a piece opens it and mounts its drawing",
    opened.ok,
    JSON.stringify(opened.value),
  );
  const after = (await target.boundingBox())?.y ?? 0;
  r.ok(
    "the opened piece's top edge holds still",
    Math.abs(after - before) <= 2,
    `${before} → ${after}`,
  );
  await page.waitForTimeout(600);
  await snap(page, out, "one-open");
  await target.click({ position: { x: 12, y: 8 } });
  const closed = await waitFor(
    () => sceneState(page),
    (s) => s.open === 0 && s.mounted === 0,
    { timeoutMs: 3000, intervalMs: 100 },
  );
  r.ok(
    "clicking it again folds it and unmounts the drawing",
    closed.ok,
    JSON.stringify(closed.value),
  );

  // --- the Components / Harness key -------------------------------------------
  await scrollPane(page, "top");
  await page
    .locator(".iceberg-split-key button", { hasText: "Harness" })
    .click();
  // the other half fades over a quarter second
  const dimmed = await waitFor(
    () =>
      page.evaluate(() => {
        const opacity = (kind: string) => {
          const el = document.querySelector(
            `.iceberg-item:not(.ghost)[data-kind="${kind}"]`,
          );
          return el ? getComputedStyle(el).opacity : "missing";
        };
        return { component: opacity("component"), harness: opacity("harness") };
      }),
    (d) => d.component === "0.18" && d.harness === "1",
    { timeoutMs: 3000, intervalMs: 100 },
  );
  r.ok(
    "Harness dims the components and keeps the harness",
    dimmed.ok,
    JSON.stringify(dimmed.value),
  );
  await snap(page, out, "harness-filter");
  await page
    .locator(".iceberg-split-key button", { hasText: "Harness" })
    .click();

  // --- Expand all ---------------------------------------------------------------
  await page.locator("body").click({ position: { x: 4, y: height - 4 } });
  await page.keyboard.press("e");
  const all = await waitFor(
    () => sceneState(page),
    (s) => s.open === PIECES && s.mounted === CARDS,
    { timeoutMs: 5000, intervalMs: 100 },
  );
  r.ok(
    `E opens all ${PIECES} pieces and mounts all ${CARDS} drawings`,
    all.ok,
    JSON.stringify(all.value),
  );
  await page.waitForTimeout(800);
  await snap(page, out, "expanded");

  // every drawing, photographed open
  const keys = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        ".iceberg-item:not(.ghost) .vz[data-card]",
      ),
    ].map((v) => v.dataset.card ?? ""),
  );
  for (const key of keys) {
    const card = page
      .locator(`.iceberg-item:not(.ghost):has(.vz[data-card="${key}"])`)
      .first();
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await card.screenshot({ path: `${out}-card-${key}.png` });
  }

  // --- the gauge at the bottom --------------------------------------------------
  await scrollPane(page, "bottom");
  const bottom = await waitFor(
    () => sceneState(page),
    (s) => s.readout.startsWith("733,354"),
    { timeoutMs: 3000, intervalMs: 100 },
  );
  r.ok(
    "at the bottom the gauge reads every line below the surface",
    bottom.ok,
    bottom.value.readout,
  );
  await snap(page, out, "bottom");

  await page.keyboard.press("e");
  const none = await waitFor(
    () => sceneState(page),
    (s) => s.open === 0 && s.mounted === 0,
    { timeoutMs: 5000, intervalMs: 100 },
  );
  r.ok("E again closes every piece", none.ok, JSON.stringify(none.value));

  await r.finish();
});
