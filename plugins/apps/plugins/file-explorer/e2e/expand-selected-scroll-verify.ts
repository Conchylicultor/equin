// Expanding a folder never scrolls back to the open (previewed) file.
//
// The table reveals its selected row when the selection changes. That reveal
// used to be keyed on the row's index, so a folder expanded ABOVE the open
// file (shifting its index) scrolled the listing back to it.
//
//  1. List the fixture (40 folders of 3 files, then 120 files — past the
//     windowing threshold), open `file-100.txt` (its preview opens).
//  2. Scroll back to the top, so the open file's row is far out of view.
//  3. Expand `a-dir-05`: the scroller's scrollTop and the folder's on-screen
//     position are unchanged.
//
// Usage:
//   ./equin run plugins/apps/plugins/file-explorer/e2e/expand-selected-scroll-verify.ts \
//     [--out /tmp/expand-selected-scroll] [--headed]

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

const out = arg("out") ?? join(tmpdir(), "expand-selected-scroll-verify");

const fixture = mkdtempSync(join(tmpdir(), "fx-sel-scroll-"));
for (let i = 0; i < 40; i++) {
  const dir = join(fixture, `a-dir-${String(i).padStart(2, "0")}`);
  mkdirSync(dir);
  for (let j = 0; j < 3; j++) writeFileSync(join(dir, `inner-${j}.txt`), "x\n");
}
for (let i = 0; i < 120; i++) {
  writeFileSync(join(fixture, `file-${String(i).padStart(3, "0")}.txt`), "x\n");
}

function row(page: Page, name: string) {
  return page.locator("[data-tree-row]", { hasText: name }).first();
}

/** Scroll the tree's scroller to its top or bottom. */
async function scrollTo(page: Page, where: "top" | "bottom") {
  await page.evaluate((w) => {
    let s: HTMLElement | null =
      document.querySelector("[data-tree-row]")?.parentElement ?? null;
    while (
      s &&
      !(
        s.scrollHeight > s.clientHeight &&
        /(auto|scroll)/.test(getComputedStyle(s).overflowY)
      )
    ) {
      s = s.parentElement;
    }
    if (s) s.scrollTop = w === "top" ? 0 : s.scrollHeight;
  }, where);
  await page.waitForTimeout(400);
}

/** The tree's scroller's scrollTop, and `name`'s top (null when not rendered). */
async function position(page: Page, name: string) {
  return page.evaluate((label) => {
    const rows = [...document.querySelectorAll("[data-tree-row]")];
    let s: HTMLElement | null = rows[0]?.parentElement ?? null;
    while (
      s &&
      !(
        s.scrollHeight > s.clientHeight &&
        /(auto|scroll)/.test(getComputedStyle(s).overflowY)
      )
    ) {
      s = s.parentElement;
    }
    const el = rows.find((r) => r.textContent?.includes(label));
    return {
      scrollTop: Math.round(s?.scrollTop ?? -1),
      top: el ? Math.round(el.getBoundingClientRect().top) : null,
    };
  }, name);
}

const r = report("expand keeps scroll away from the open file");

try {
  await withBrowser(async (h) => {
    const { page } = await h.session({
      viewport: { width: 1440, height: 900 },
    });
    await boot(
      page,
      pathUrl(`/files/computer/at/${encodeURIComponent(fixture)}`),
      {
        marker: "[data-tree-row]",
      },
    );
    await row(page, "a-dir-00").waitFor({ state: "visible" });
    await scrollTo(page, "bottom");
    await row(page, "file-100.txt").waitFor({ state: "visible" });
    await row(page, "file-100.txt").click();
    await page.waitForTimeout(800);
    r.ok("the file opens", page.url().endsWith("/file-100.txt"), page.url());
    await snap(page, out, "1-open");

    await scrollTo(page, "top");
    await row(page, "a-dir-05").waitFor({ state: "visible" });
    await row(page, "a-dir-05").evaluate((el) =>
      el.scrollIntoView({ block: "center" }),
    );
    await page.waitForTimeout(300);
    const before = await position(page, "a-dir-05");
    await snap(page, out, "2-scrolled-away");

    await row(page, "a-dir-05").hover();
    await row(page, "a-dir-05").locator("button[aria-label='Expand']").click();
    await page.waitForTimeout(1500);
    const after = await position(page, "a-dir-05");
    await snap(page, out, "3-expanded");
    r.ok(
      "expanding keeps the scroll",
      after.scrollTop === before.scrollTop,
      `scrollTop ${before.scrollTop} → ${after.scrollTop}`,
    );
    r.ok(
      "expanding keeps the folder in place",
      before.top !== null &&
        after.top !== null &&
        Math.abs(after.top - before.top) <= 1,
      `top ${before.top} → ${after.top}`,
    );
  });
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

await r.finish();
