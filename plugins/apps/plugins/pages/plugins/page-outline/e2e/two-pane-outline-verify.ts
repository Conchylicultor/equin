// The outline rail must resolve headings in the pane it belongs to.
//
// The Pages app can show two documents side by side (`/pages/page/:a/page/:b`),
// which mounts TWO `BlockEditor`s and TWO `PageOutline`s. Open the SAME page in
// both and every heading id exists twice, so a `document`-wide lookup answers
// with whichever row is first in the DOM — the left pane's — and the right
// pane's rail highlights nothing and scrolls the wrong document.
//
// Measured baseline, against `main` at 1440x900 with one 3-heading page open in
// both panes:
//
//   right pane, click outline dash #3   left pane scrolled, right pane did not
//   right pane, active dash             none (its rows resolved to pane 0)
//
// Cause: `resolveBlockRow` was `document.querySelector('[data-block-id="…"]')`.
//
// Usage:
//   ./equin run \
//     plugins/apps/plugins/pages/plugins/page-outline/e2e/two-pane-outline-verify.ts \
//     [--url <deploy>] [--headed]
import {
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openBlankPage } from "@plugins/page/plugins/editor/e2e";

const r = report();

/** Headings, with filler between them so the document actually scrolls. */
const HEADINGS = ["Alpha section", "Bravo section", "Charlie section"];
/**
 * Few, LONG filler paragraphs rather than many short ones. Height is what the
 * scroll assertions need, and a wrapping paragraph buys it per block — where a
 * block per line means ~40 blocks of typing, which is where an earlier version
 * of this script raced the editor and seeded one heading instead of three.
 */
const FILLER_PARAGRAPHS = 4;
const FILLER = "lorem ipsum dolor sit amet ".repeat(16);

await withBrowser(async (h) => {
  const { page } = await h.session();

  // ---- Seed one page with three headings separated by filler ---------------

  const doc = await openBlankPage(page, { settleMs: 2000 });
  for (const heading of HEADINGS) {
    await page.keyboard.type(`# ${heading}`);
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    for (let f = 0; f < FILLER_PARAGRAPHS; f++) {
      await page.keyboard.type(FILLER);
      await page.waitForTimeout(200);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
    }
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1000);

  // Seeding is the one part of this script that can silently under-deliver, so
  // assert it before anything depends on it — three headings, or the rail
  // assertions below would be measuring a document that was never built.
  const seeded = await page.evaluate(
    () => document.querySelectorAll('[data-block-id] [role="heading"]').length,
  );
  r.ok(
    `seeded ${HEADINGS.length} headings (${seeded})`,
    seeded === HEADINGS.length,
  );

  // ---- The SAME page in both panes — the case that collides ---------------

  await page.goto(pathUrl(`/pages/page/${doc.pageId}/page/${doc.pageId}`), {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const surfaces = page.locator('[aria-label="Page blocks"]');
  await surfaces.nth(1).waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(3000);

  const paneCount = await surfaces.count();
  r.ok(`the page is open in two panes (${paneCount})`, paneCount === 2);

  const rails = page.locator('[data-outline-rail][aria-label="Page outline"]');
  const railCount = await rails.count();
  r.ok(
    `each pane rendered its own outline rail (${railCount})`,
    railCount === 2,
  );

  // The fixture must EXERCISE the hazard or every assertion below passes for the
  // wrong reason. State the old resolution directly — scan the document in DOM
  // order, the way `resolveBlockRow` used to — and check that a heading id
  // resolves into the LEFT pane. If the panes ever stop sharing ids, this fails
  // loudly instead of leaving the script green and blind.
  const headingIds = await page.evaluate(() => {
    const surface = document.querySelectorAll('[aria-label="Page blocks"]')[1];
    if (!surface) return [];
    return [...surface.querySelectorAll("[data-block-id]")]
      .filter((el) => el.querySelector('[role="heading"]') !== null)
      .map((el) => el.getAttribute("data-block-id") ?? "");
  });
  r.ok(
    `the right pane renders the headings (${headingIds.length})`,
    headingIds.length >= HEADINGS.length,
  );

  const documentOrderPane = await page.evaluate(
    (id) => {
      const surfaces = [
        ...document.querySelectorAll('[aria-label="Page blocks"]'),
      ];
      const el = document.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
      return el ? surfaces.findIndex((s) => s.contains(el)) : -1;
    },
    headingIds[headingIds.length - 1] ?? "",
  );
  r.ok(
    `a document-wide lookup of a RIGHT-pane heading resolves to the LEFT pane (pane ${documentOrderPane}) — the bug this script guards`,
    documentOrderPane === 0,
  );

  // ---- Clicking an entry moves the pane the rail belongs to ----------------

  /**
   * Where each pane's LAST heading currently sits, in viewport coordinates.
   *
   * Deliberately not a scroller's `scrollTop`: which element actually scrolls is
   * an implementation detail of the pane chrome, and walking up for "the first
   * ancestor that overflows" found a different node in each pane (1467px vs
   * 4539px of overflow for the same document). A heading's own rect is the thing
   * the feature is about — "did THIS pane travel to ITS heading" — and it needs
   * no such guess.
   */
  const lastHeadingTops = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[aria-label="Page blocks"]')].map((s) => {
        const rows = [...s.querySelectorAll("[data-block-id]")].filter(
          (el) => el.querySelector('[role="heading"]') !== null,
        );
        const last = rows[rows.length - 1];
        return last ? last.getBoundingClientRect().top : Number.NaN;
      }),
    );

  for (const [name, pane] of [
    ["left", 0],
    ["right", 1],
  ] as const) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await surfaces.nth(1).waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForTimeout(3000);

    const before = await lastHeadingTops();
    const other = pane === 0 ? 1 : 0;
    r.ok(
      `${name} pane: its last heading starts below the fold (${Math.round(before[pane] ?? 0)}px)`,
      (before[pane] ?? 0) > 400,
    );

    const rail = rails.nth(pane);
    await rail.hover();
    await page.waitForTimeout(600);
    // The LAST entry, so the jump is unambiguous and far from the top.
    await rail.locator("[data-outline-row]").last().click();
    await page.waitForTimeout(1200);

    const after = await lastHeadingTops();
    const moved = (before[pane] ?? 0) - (after[pane] ?? 0);
    const otherMoved = Math.abs((before[other] ?? 0) - (after[other] ?? 0));
    r.ok(
      `${name} rail: travelled to ITS OWN last heading (moved ${Math.round(moved)}px up)`,
      moved > 200,
    );
    r.ok(
      `${name} rail: the other pane stayed put (moved ${Math.round(otherMoved)}px)`,
      otherMoved < 20,
    );
  }

  // ---- The rail reports a position, rather than dying on zero rects --------

  for (const [name, pane] of [
    ["left", 0],
    ["right", 1],
  ] as const) {
    const active = await rails
      .nth(pane)
      .locator("[data-outline-dash][data-active='true']")
      .count();
    r.ok(`${name} rail: marks an active entry (${active})`, active === 1);
  }
});

await r.finish();
