// The file explorer, end to end on a deployed build.
//
// A throwaway folder is made on the host (the deploy reads the same disk):
//   fx-e2e-<random>/
//     notes.md      → a rendered Markdown preview
//     blob.xyz      → binary, no preview: the fallback
//     sub/inner.txt → a folder to expand lazily and to re-root into
//     archive.zip   → photos/note.txt, browsed like a folder
//
//  1. /files opens on the home folder.
//  2. ⌘L, type the folder's path minus its last letters, Tab completes it,
//     Enter lists it (and the URL names it).
//  3. Expand `sub` with its chevron: `inner.txt` appears under it.
//  4. Click `notes.md`: the preview renders its heading.
//  5. Click `blob.xyz`: the preview says it has no preview.
//  6. Double-click `sub`: it becomes the listing; Back returns.
//  7. Expand `archive.zip`, then `photos` inside it; click `note.txt`: its
//     text previews, with no Open with default app (it has no file of its own).
//
// Along the way it checks the Files look (prototype proto-1790864772-0r54) at
// 1440×900: the brand reads "Files", the sidebar is 224px, the toolbar 48px
// and a tree row 30px, Modified is left-aligned, a selected row's name takes
// the accent text colour, an expanded folder's children draw indent guides,
// the status bar says nothing about free space, and the path bar shows every
// ancestor of a short path (no "…" fold) when it has the room.
//
// Usage:
//   ./equin run plugins/apps/plugins/file-explorer/e2e/explorer-verify.ts \
//     [--out /tmp/explorer] [--headed]

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out") ?? join(tmpdir(), "explorer-verify");

const fixture = mkdtempSync(join(tmpdir(), "fx-e2e-"));
writeFileSync(
  join(fixture, "notes.md"),
  "# Explorer fixture\n\nA **rendered** paragraph.\n",
);
writeFileSync(join(fixture, "blob.xyz"), Buffer.from([0, 1, 2, 0, 255, 0]));
mkdirSync(join(fixture, "sub"));
writeFileSync(join(fixture, "sub", "inner.txt"), "inner\n");
const zipSrc = mkdtempSync(join(tmpdir(), "fx-e2e-zip-"));
mkdirSync(join(zipSrc, "photos"));
writeFileSync(join(zipSrc, "photos", "note.txt"), "A zipped note\n");
await spawnExpectOk(
  ["zip", "-q", "-r", join(fixture, "archive.zip"), "photos"],
  {
    cwd: zipSrc,
    timeoutMs: 20_000,
  },
);
rmSync(zipSrc, { recursive: true, force: true });

/** An element's rendered box. */
async function box(page: Page, selector: string) {
  return page.locator(selector).first().boundingBox();
}

/** A tree row by its label. */
function row(page: Page, name: string) {
  return page.locator("[data-tree-row]", { hasText: name }).first();
}

async function waitRow(page: Page, name: string): Promise<boolean> {
  try {
    await row(page, name).waitFor({ state: "visible", timeout: 10_000 });
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") return false;
    throw err;
  }
}

const r = report("file explorer");

try {
  await withBrowser(async (h) => {
    const { page } = await h.session({
      viewport: { width: 1440, height: 900 },
    });

    // 1. Home.
    await boot(page, pathUrl("/files"), { marker: "[data-tree-row]" });
    r.ok(
      "home lists rows",
      (await page.locator("[data-tree-row]").count()) > 0,
    );
    await snap(page, out, "1-home");

    // The Files look.
    r.ok(
      "the sidebar brand reads Files",
      await page
        .locator("[data-slot=sidebar-inner]")
        .getByRole("button", { name: "Files", exact: true })
        .isVisible(),
    );
    const sidebar = await box(page, "[data-slot=sidebar-container]");
    r.ok(
      "the sidebar is 224px wide",
      sidebar !== null && Math.round(sidebar.width) === 224,
      `width ${sidebar?.width}`,
    );
    const toolbar = await page
      .getByRole("button", { name: "Enclosing folder" })
      .first()
      .evaluate((el) => {
        const bar = el.closest(".h-chrome-pane");
        return bar === null ? null : bar.getBoundingClientRect().height;
      });
    r.ok("the toolbar is 48px tall", toolbar === 48, `height ${toolbar}`);
    const rowBox = await box(page, "[data-tree-row]");
    r.ok(
      "a tree row is 30px tall",
      rowBox !== null && Math.round(rowBox.height) === 30,
      `height ${rowBox?.height}`,
    );
    const modifiedAlign = await page
      .locator("[data-aligned-cell=modified]")
      .first()
      .evaluate((el) => getComputedStyle(el).textAlign);
    r.ok(
      "Modified is left-aligned",
      modifiedAlign === "left" || modifiedAlign === "start",
      modifiedAlign,
    );
    const status = await page
      .locator("text=/^\\d+ items?/")
      .first()
      .evaluate((el) => el.closest(".border-t")?.textContent ?? "");
    r.ok(
      "the status bar says nothing about free space",
      status !== "" && !status.includes("available"),
      status,
    );

    // 2. ⌘L → type a prefix → Tab → Enter.
    await page.keyboard.press("ControlOrMeta+l");
    const field = page
      .getByRole("combobox", { name: "Path" })
      .or(page.getByLabel("Path"))
      .first();
    await field.waitFor({ state: "visible", timeout: 5_000 });
    const prefix = fixture.slice(0, -3);
    await field.fill(prefix);
    await page.waitForTimeout(800);
    await field.press("Tab");
    await page.waitForTimeout(300);
    const completed = await field.inputValue();
    r.ok(
      "Tab completes the folder",
      completed
        .replace(/\/$/, "")
        .endsWith(fixture.slice(fixture.lastIndexOf("/"))),
      `field reads ${completed}`,
    );
    await field.press("Enter");
    r.ok("Enter lists the folder", await waitRow(page, "notes.md"));
    r.ok(
      "the URL names the folder",
      decodeURIComponent(page.url()).includes(
        fixture.slice(fixture.lastIndexOf("/")),
      ),
      page.url(),
    );
    r.ok("its subfolder is listed", await waitRow(page, "sub"));
    await snap(page, out, "2-listing");
    // The fixture's path is short enough to show whole at 1440px: no "…"
    // holding folded ancestors.
    const folded = await page
      .getByRole("button", { name: /^Show the \d+ levels above this one$/ })
      .count();
    r.ok("the path bar shows every ancestor (no fold)", folded === 0);

    // 3. Expand `sub` lazily.
    await row(page, "sub").hover();
    await row(page, "sub").locator("button[aria-label='Expand']").click();
    r.ok("expanding lists the subfolder", await waitRow(page, "inner.txt"));
    r.ok(
      "the expanded folder's children draw indent guides",
      (await row(page, "inner.txt").locator("[data-tree-guides]").count()) > 0,
    );
    await snap(page, out, "3-expanded");

    // 4. Markdown preview.
    await row(page, "notes.md").click();
    const heading = page.locator("h1", { hasText: "Explorer fixture" });
    let rendered = true;
    try {
      await heading.waitFor({ state: "visible", timeout: 10_000 });
    } catch (err) {
      if (!(err instanceof Error && err.name === "TimeoutError")) throw err;
      rendered = false;
    }
    r.ok("a .md file renders as Markdown", rendered);
    const colors = await row(page, "notes.md").evaluate((el) => {
      const name = Array.from(el.querySelectorAll("span")).find(
        (s) => s.textContent?.trim() === "notes.md",
      );
      const probe = document.createElement("span");
      probe.className = "text-primary-text";
      el.appendChild(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return {
        name: name ? getComputedStyle(name).color : null,
        accent,
        bg: getComputedStyle(el).backgroundColor,
      };
    });
    r.ok(
      "the selected row's name takes the accent text colour",
      colors.name !== null &&
        colors.name !== "rgb(24, 24, 27)" &&
        colors.bg !== "rgba(0, 0, 0, 0)",
      JSON.stringify(colors),
    );
    await snap(page, out, "4-markdown");

    // 5. Unknown binary → fallback.
    await row(page, "blob.xyz").click();
    const noPreview = page.getByText(/No preview for/);
    let fellBack = true;
    try {
      await noPreview.waitFor({ state: "visible", timeout: 10_000 });
    } catch (err) {
      if (!(err instanceof Error && err.name === "TimeoutError")) throw err;
      fellBack = false;
    }
    r.ok("an unknown binary falls back", fellBack);
    await snap(page, out, "5-fallback");

    // 6. Re-root into `sub`, then Back.
    await row(page, "sub").dblclick();
    await page.waitForTimeout(800);
    r.ok(
      "double-click re-roots",
      decodeURIComponent(page.url()).includes("/sub"),
      page.url(),
    );
    r.ok("the subfolder is the listing", await waitRow(page, "inner.txt"));
    await snap(page, out, "6-rerooted");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    r.ok("Back returns to the folder", await waitRow(page, "notes.md"));

    // 7. A zip browses like a folder.
    await row(page, "archive.zip").hover();
    await row(page, "archive.zip")
      .locator("button[aria-label='Expand']")
      .click();
    r.ok("expanding a zip lists its root", await waitRow(page, "photos"));
    await row(page, "photos").hover();
    await row(page, "photos").locator("button[aria-label='Expand']").click();
    r.ok("a folder inside the zip expands", await waitRow(page, "note.txt"));
    await row(page, "note.txt").click();
    const zipped = page.getByText("A zipped note");
    let previewed = true;
    try {
      await zipped.waitFor({ state: "visible", timeout: 10_000 });
    } catch (err) {
      if (!(err instanceof Error && err.name === "TimeoutError")) throw err;
      previewed = false;
    }
    r.ok("a file inside the zip previews", previewed);
    r.ok(
      "a file inside the zip offers no Open with default app",
      (await page
        .getByRole("button", { name: "Open with default app" })
        .count()) === 0,
    );
    await snap(page, out, "7-zip");
  });
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

await r.finish();
