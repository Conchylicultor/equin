// Expanding a folder keeps the listing where it is.
//
// A throwaway folder: 40 empty folders, then `m-big` (40 files), then 40 files
// — folders sort first, so `m-big` sits mid-list. Opening `m-big` takes the
// painted rows past the tree's windowing threshold (100): the tree swaps into
// VirtualRows, whose virtualizer used to write scrollTop = 0 on attaching —
// throwing the listing back to the top.
//
//  1. List the fixture, scroll so `m-big` sits mid-viewport.
//  2. Click its chevron (a click on the name would navigate into it).
//  3. The scroller's scrollTop and `m-big`'s on-screen position are unchanged.
//  4. Collapse it again (back under the threshold): still unchanged.
//
// Usage:
//   ./equin run plugins/apps/plugins/file-explorer/e2e/expand-scroll-verify.ts \
//     [--out /tmp/expand-scroll] [--headed]

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

const out = arg("out") ?? join(tmpdir(), "expand-scroll-verify");

const fixture = mkdtempSync(join(tmpdir(), "fx-scroll-"));
// Folders sort first, so pad with leading folders to put `m-big` mid-list.
for (let i = 0; i < 40; i++) {
  mkdirSync(join(fixture, `a-dir-${String(i).padStart(2, "0")}`));
}
mkdirSync(join(fixture, "m-big"));
for (let i = 0; i < 40; i++) {
  writeFileSync(join(fixture, "m-big", `inner-${i}.txt`), "x\n");
}
for (let i = 0; i < 40; i++) {
  writeFileSync(join(fixture, `file-${String(i).padStart(2, "0")}.txt`), "x\n");
}

function row(page: Page, name: string) {
  return page.locator("[data-tree-row]", { hasText: name }).first();
}

/**
 * The tree's scroll container's scrollTop, and `name`'s top in the viewport
 * (null when its row is not rendered — scrolled out of the window).
 */
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

/** Click a row's disclosure chevron (revealed on hover). */
async function toggle(page: Page, name: string, label: "Expand" | "Collapse") {
  await row(page, name).hover();
  await row(page, name).locator(`button[aria-label='${label}']`).click();
}

/** Whether `after` shows the folder where `before` did. */
function samePlace(
  before: { top: number | null },
  after: { top: number | null },
): boolean {
  return (
    before.top !== null &&
    after.top !== null &&
    Math.abs(after.top - before.top) <= 1
  );
}

const r = report("expand keeps scroll");

try {
  await withBrowser(async (h) => {
    const { page } = await h.session({
      viewport: { width: 1440, height: 900 },
    });
    await boot(page, pathUrl(`/files/at/${encodeURIComponent(fixture)}`), {
      marker: "[data-tree-row]",
    });
    await row(page, "m-big").waitFor({ state: "visible" });
    await row(page, "m-big").evaluate((el) =>
      el.scrollIntoView({ block: "center" }),
    );
    await page.waitForTimeout(300);
    const before = await position(page, "m-big");
    await snap(page, out, "1-before");

    const listingUrl = page.url();
    await toggle(page, "m-big", "Expand");
    await page.waitForTimeout(1500);
    r.ok(
      "the chevron does not navigate",
      page.url() === listingUrl,
      page.url(),
    );
    const afterOpen = await position(page, "m-big");
    await snap(page, out, "2-open");
    r.ok(
      "opening keeps the scroll",
      before.scrollTop > 0 && afterOpen.scrollTop === before.scrollTop,
      `scrollTop ${before.scrollTop} → ${afterOpen.scrollTop}`,
    );
    r.ok(
      "opening keeps the folder in place",
      samePlace(before, afterOpen),
      `top ${before.top} → ${afterOpen.top}`,
    );

    // Close it again (only reachable when opening kept it on screen).
    if (afterOpen.top !== null) {
      await toggle(page, "m-big", "Collapse");
      await page.waitForTimeout(500);
      const afterClose = await position(page, "m-big");
      await snap(page, out, "3-closed");
      r.ok(
        "closing keeps the folder in place",
        samePlace(before, afterClose),
        `top ${before.top} → ${afterClose.top}`,
      );
    }
  });
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

await r.finish();
