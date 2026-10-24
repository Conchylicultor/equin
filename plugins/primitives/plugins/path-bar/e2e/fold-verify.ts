// The path bar's breadcrumb folds its ancestors only when they do not fit.
//
// Opens the File Explorer (the path bar's consumer) on a deep host folder at a
// wide viewport, where every ancestor fits, and asserts the trail shows them all
// — then narrows the window until it must fold, and widens it again to check the
// ancestors come back.
//
// Usage:
//   ./equin run plugins/primitives/plugins/path-bar/e2e/fold-verify.ts \
//     [--out /tmp/path-bar-fold] [--headed]

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out") ?? join(tmpdir(), "path-bar-fold");
// Optionally also probe a real folder of the caller's choosing, with one of its
// files open: `--dir ~/code/project --file README.md`.
const extraDir = arg("dir");
const extraFile = arg("file");

// A short deep chain: a handful of ancestors that comfortably fit at 1440px.
const root = mkdtempSync(join(tmpdir(), "pb-"));
const deep = join(root, "alpha", "beta", "gamma");
mkdirSync(deep, { recursive: true });
writeFileSync(join(deep, "notes.md"), "# Notes\n");

interface TrailProbe {
  folded: boolean;
  crumbs: number;
  rootWidth: number;
  barWidth: number;
  leafDeficit: number;
}

/** What the crumb-mode trail looks like right now. */
async function probe(page: Page): Promise<TrailProbe> {
  return page.evaluate(() => {
    const bar = document.querySelector("[data-path-bar='crumbs']");
    if (!bar) throw new Error("no crumb-mode path bar on the page");
    const trail = bar.firstElementChild as HTMLElement;
    const leaf = (trail.querySelector("[data-breadcrumb-leaf]") ??
      trail.lastElementChild) as HTMLElement | null;
    return {
      folded: bar.querySelector("[aria-label^='Show the']") !== null,
      crumbs: trail.querySelectorAll("button").length,
      rootWidth: trail.getBoundingClientRect().width,
      barWidth: bar.getBoundingClientRect().width,
      leafDeficit: leaf ? leaf.scrollWidth - leaf.clientWidth : -1,
    };
  });
}

const r = report("path bar fold");

try {
  await withBrowser(async (h) => {
    const { page } = await h.session({
      viewport: { width: 1440, height: 900 },
    });
    await boot(page, pathUrl("/files"), { marker: "[data-tree-row]" });

    await page.keyboard.press("ControlOrMeta+l");
    const field = page.getByRole("combobox", { name: "Path" }).first();
    await field.waitFor({ state: "visible", timeout: 5_000 });
    await field.fill(deep);
    await field.press("Enter");
    await page
      .locator("[data-path-bar='crumbs']")
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(1_000);

    const wide = await probe(page);
    r.ok("wide: every ancestor is shown", !wide.folded, JSON.stringify(wide));
    await snap(page, out, "1-wide");

    await page.setViewportSize({ width: 560, height: 900 });
    await page.waitForTimeout(800);
    const narrow = await probe(page);
    r.ok("narrow: the ancestors fold", narrow.folded, JSON.stringify(narrow));
    await snap(page, out, "2-narrow");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(800);
    const back = await probe(page);
    r.ok(
      "widened again: the ancestors come back",
      !back.folded,
      JSON.stringify(back),
    );
    await snap(page, out, "3-widened");

    // A cold boot straight onto the deep folder: the trail's first layout
    // happens while the app is still settling around it.
    const deepUrl = page.url();
    const cold = await h.session({ viewport: { width: 1440, height: 900 } });
    await boot(cold.page, deepUrl, { marker: "[data-path-bar='crumbs']" });
    await cold.page.waitForTimeout(1_500);
    const booted = await probe(cold.page);
    r.ok(
      "cold boot on the folder: every ancestor is shown",
      !booted.folded,
      JSON.stringify(booted),
    );
    await snap(cold.page, out, "4-cold-boot");

    // Opening a file narrows the toolbar (the preview takes half the room),
    // closing it gives the room back.
    await cold.page
      .locator("[data-tree-row]", { hasText: "notes.md" })
      .first()
      .click();
    await cold.page.waitForTimeout(1_500);
    const opened = await probe(cold.page);
    console.log(`with the preview open: ${JSON.stringify(opened)}`);
    await snap(cold.page, out, "5-preview-open");
    await cold.page
      .getByRole("button", { name: "Close (Esc)", exact: true })
      .click();
    await cold.page.waitForTimeout(1_500);
    const closed = await probe(cold.page);
    r.ok(
      "preview closed: every ancestor is shown again",
      !closed.folded,
      JSON.stringify(closed),
    );
    await snap(cold.page, out, "6-preview-closed");

    if (extraDir) {
      await cold.page.keyboard.press("ControlOrMeta+l");
      const f = cold.page.getByRole("combobox", { name: "Path" }).first();
      await f.waitFor({ state: "visible", timeout: 5_000 });
      await f.fill(extraDir);
      await f.press("Enter");
      await cold.page.waitForTimeout(1_500);
      console.log(`${extraDir}: ${JSON.stringify(await probe(cold.page))}`);
      await snap(cold.page, out, "7-dir");
      if (extraFile) {
        await cold.page
          .locator("[data-tree-row]", { hasText: extraFile })
          .first()
          .click();
        await cold.page.waitForTimeout(1_500);
        console.log(
          `${extraDir} + ${extraFile}: ${JSON.stringify(await probe(cold.page))}`,
        );
        await snap(cold.page, out, "8-dir-file");
      }
    }
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

await r.finish();
