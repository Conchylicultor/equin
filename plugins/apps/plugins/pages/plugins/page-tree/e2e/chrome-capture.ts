// Photographs the Pages chrome's menus — in the deployed app and in the
// prototype it was matched against — and diffs each pair, so "does the kind
// menu look like the mockup?" comes back as a number and a picture.
//
// First it crops fixed regions of the chrome at rest (sidebar head and
// footer, toolbar, page header) from both documents. Then it opens, one at a
// time:
//   kind     — the page-kind pill's menu
//   section  — the Private section header's ⋯ panel (header hovered first)
//   icon     — the page icon's picker
//   cover    — the cover picker (header hovered, then Add cover)
//   backlinks — the "Linked from" panel under the title
// and crops the union of the trigger and what it opened (plus a margin), at
// one size for both halves, anchored at each half's own trigger.
//
// Writes, per menu, `<out>-<menu>-mock.png`, `-app.png`, `-diff.png`,
// `-side-by-side.png` and `-colors.png`, and logs the differing-pixel ratio,
// the heatmap and the colour report.
//
// Usage:
//   ./equin run plugins/apps/plugins/pages/plugins/page-tree/e2e/chrome-capture.ts \
//     [--proto proto-1790691924-p8nh] [--page block-acef974d-…] [--only kind,cover] \
//     [--out /tmp/pages-chrome] [--color-scheme dark|light] [--threshold 0.1] [--delta-e 5]

import { writeFileSync } from "node:fs";
import type { Locator, Page } from "playwright";
import {
  arg,
  colorReport,
  colorReportText,
  diffImages,
  heatmapText,
  numArg,
  pathUrl,
  report,
  withBrowser,
  type ColorScheme,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const proto = arg("proto", "proto-1790691924-p8nh");
const pageId = arg("page", "block-acef974d-f091-429d-941b-89c6a32a70f3");
const out = arg("out", "/tmp/pages-chrome");
const colorScheme = arg("color-scheme", "dark") as ColorScheme;
const threshold = numArg("threshold", 0.1);
const deltaE = numArg("delta-e", 5);
const only = arg("only")?.split(",");
/** Room around the trigger ∪ popup box: the popup's shadow and ring. */
const MARGIN = 12;
const VIEWPORT = { width: 1440, height: 900 };

type Box = { x: number; y: number; width: number; height: number };

/** One side's way of opening a menu: the trigger, and what it opened. */
interface Opened {
  trigger: Locator;
  popup: Locator;
}

interface Side {
  /** Load the document and wait until its chrome is on screen. */
  load(page: Page): Promise<void>;
  open: Record<MenuId, (page: Page) => Promise<Opened>>;
}

const MENUS = ["kind", "section", "icon", "cover", "backlinks"] as const;
type MenuId = (typeof MENUS)[number];

/** The app's open popup: the last visible popover/menu surface. */
function appPopup(page: Page): Locator {
  return page
    .locator(
      '[data-slot="popover-content"]:visible, [data-slot="dropdown-menu-content"]:visible',
    )
    .last();
}

const APP: Side = {
  async load(page) {
    await page.goto(pathUrl(`/pages/page/${pageId}?embed=1`));
    await page
      .getByRole("button", { name: /^Page kind:/ })
      .waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);
  },
  open: {
    async kind(page) {
      const trigger = page.getByRole("button", { name: /^Page kind:/ });
      await trigger.click();
      return { trigger, popup: appPopup(page) };
    },
    async section(page) {
      const label = page.getByText("Private", { exact: true }).first();
      await label.hover();
      const trigger = label.locator(
        'xpath=ancestor::*[.//button[@aria-label="Section options"]][1]//button[@aria-label="Section options"]',
      );
      await trigger.click();
      return { trigger, popup: appPopup(page) };
    },
    async icon(page) {
      const trigger = page.getByRole("button", { name: "Change page icon" });
      await trigger.click();
      return { trigger, popup: appPopup(page) };
    },
    async cover(page) {
      await page.getByRole("button", { name: "Change page icon" }).hover();
      const trigger = page.getByRole("button", { name: "Add cover" });
      await trigger.click();
      return { trigger, popup: appPopup(page) };
    },
    async backlinks(page) {
      const trigger = page.getByRole("button", { name: /^Linked from/ });
      await trigger.click();
      return {
        trigger,
        popup: page.getByRole("region", { name: "Pages linking here" }),
      };
    },
  },
};

const MOCK: Side = {
  async load(page) {
    await page.goto(pathUrl(`/api/prototypes/${proto}/index.html`));
    await page.locator('[data-act="kind"]').waitFor({ timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
  },
  open: {
    async kind(page) {
      const trigger = page.locator('[data-act="kind"]');
      await trigger.click();
      return { trigger, popup: page.locator(".kind-pop") };
    },
    async section(page) {
      const head = page.locator('.section[data-section="private"]');
      await head.hover();
      const trigger = head.locator('[data-act="sect-more"]');
      await trigger.click();
      return { trigger, popup: page.locator("#sect-pop") };
    },
    async icon(page) {
      const trigger = page.locator(".page-icon");
      await trigger.click();
      return { trigger, popup: page.locator("#icon-pop") };
    },
    async cover(page) {
      await page.locator(".doc-head").first().hover();
      const trigger = page.locator('[data-act="cover-pick"]');
      await trigger.click();
      return { trigger, popup: page.locator("#cover-pop") };
    },
    async backlinks(page) {
      const trigger = page.locator('[data-act="bl"]');
      await trigger.click();
      return { trigger, popup: page.locator(".bl-inline .bl-list") };
    },
  },
};

/**
 * Fixed screen regions of the chrome at rest, cropped at the same rectangle
 * on both sides (the mockup and the app share one layout at this viewport).
 * The sidebar tree is left out: its rows are indented by the tree disclosure
 * column, a decided difference.
 */
const REGIONS: Record<string, Box> = {
  "sidebar-head": { x: 0, y: 0, width: 260, height: 86 },
  "sidebar-footer": { x: 0, y: 820, width: 260, height: 80 },
  toolbar: { x: 261, y: 0, width: 1179, height: 46 },
  header: { x: 500, y: 90, width: 700, height: 250 },
};

async function box(loc: Locator, what: string): Promise<Box> {
  await loc.waitFor({ state: "visible", timeout: 10_000 });
  const b = await loc.boundingBox();
  if (!b) throw new Error(`${what}: no bounding box`);
  return b;
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** Open `menu` on a freshly loaded document; the trigger ∪ popup box. */
async function openOn(side: Side, page: Page, menu: MenuId): Promise<Box> {
  await side.load(page);
  await page.mouse.move(0, 0);
  const { trigger, popup } = await side.open[menu](page);
  const t = await box(trigger, `${menu} trigger`);
  const p = await box(popup, `${menu} popup`);
  // Let the open transition finish before the pixels are read.
  await page.waitForTimeout(400);
  return union(t, p);
}

await withBrowser(async (h) => {
  const r = report("pages chrome capture");
  const app = await h.session({
    viewport: VIEWPORT,
    colorScheme,
    label: "app",
  });
  const mock = await h.session({
    viewport: VIEWPORT,
    colorScheme,
    label: "mock",
  });

  const compare = async (
    name: string,
    mockPng: Buffer,
    appPng: Buffer,
    note: string,
  ): Promise<void> => {
    const prefix = `${out}-${name}`;
    writeFileSync(`${prefix}-mock.png`, mockPng);
    writeFileSync(`${prefix}-app.png`, appPng);
    const diff = await diffImages(app.page, mockPng, appPng, {
      threshold,
      labels: [`mock — ${name}`, `app — ${name}`],
    });
    writeFileSync(`${prefix}-diff.png`, diff.diffPng);
    writeFileSync(`${prefix}-side-by-side.png`, diff.sideBySidePng);
    const colors = await colorReport(app.page, mockPng, appPng, {
      deltaE,
      labels: ["mock", "app"],
    });
    writeFileSync(`${prefix}-colors.png`, colors.sheetPng);
    console.log(`\n── ${name} ──`);
    console.log(note);
    console.log(`mismatch: ${(diff.ratio * 100).toFixed(2)}% of ${diff.total}`);
    console.log(heatmapText(diff.grid));
    console.log(colorReportText(colors));
    console.log(`wrote ${prefix}-{mock,app,diff,side-by-side,colors}.png`);
    r.ok(`${name} captured on both sides`, diff.sameSize);
  };

  if (!only || only.includes("regions")) {
    await APP.load(app.page);
    await MOCK.load(mock.page);
    for (const p of [app.page, mock.page]) await p.mouse.move(0, 0);
    for (const [name, clip] of Object.entries(REGIONS)) {
      await compare(
        `region-${name}`,
        await mock.page.screenshot({ clip }),
        await app.page.screenshot({ clip }),
        `region:   ${clip.width}×${clip.height} at ${clip.x},${clip.y}`,
      );
    }
  }

  for (const menu of MENUS) {
    if (only && !only.includes(menu)) continue;
    // A menu that will not open on one side (the app page has no backlinks,
    // say) fails that menu's line and the run, without hiding the others.
    let a: Box;
    let m: Box;
    try {
      a = await openOn(APP, app.page, menu);
      m = await openOn(MOCK, mock.page, menu);
    } catch (err) {
      r.fail(
        `${menu} opens on both sides`,
        err instanceof Error ? err.message.split("\n")[0]! : String(err),
      );
      continue;
    }
    // One size for both halves, each anchored at its own box's top-left.
    const w = Math.ceil(Math.max(a.width, m.width)) + 2 * MARGIN;
    const hgt = Math.ceil(Math.max(a.height, m.height)) + 2 * MARGIN;
    const clip = (b: Box) => ({
      x: Math.max(0, Math.floor(b.x) - MARGIN),
      y: Math.max(0, Math.floor(b.y) - MARGIN),
      width: w,
      height: hgt,
    });
    await compare(
      menu,
      await mock.page.screenshot({ clip: clip(m) }),
      await app.page.screenshot({ clip: clip(a) }),
      `boxes:    mock ${Math.round(m.width)}×${Math.round(m.height)}, app ${Math.round(a.width)}×${Math.round(a.height)}`,
    );
  }
  for (const err of app.captured.pageErrors) r.note(`app page error: ${err}`);
  await r.finish();
});
