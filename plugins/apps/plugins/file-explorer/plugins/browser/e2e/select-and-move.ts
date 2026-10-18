// Row selection, drag to move and drag to pin in the file explorer, end to end
// on a deployed build. A throwaway folder is made under the home directory
// (the deploy reads the same disk) and removed at the end:
//
//   ~/.singularity-e2e-move-<random>/
//     a.txt b.txt c.txt   → selected, then dragged into Docs
//     Docs/sub/           → a collapsed folder that springs open; its own child
//     Target/x.txt        → the name a dropped x.txt collides with
//
//  1. Pressing on a row and dragging across rows selects no text.
//  2. ⌘-click, Shift-click and ⌘A select (aria-selected counts).
//  3. a.txt + b.txt dragged onto the collapsed Docs: it springs open after
//     ~700 ms; dropped, both move on disk.
//  4. Docs dragged onto its own child: no drop, nothing moves. Inside the
//     expanded Docs, a.txt dropped back on itself or on its sibling b.txt is
//     no drop either (it cancels); c.txt dropped on Docs/b.txt goes into Docs
//     (a file row's drop is its folder's, the folder highlighted).
//  5. x.txt dropped onto Target, three times: the conflict dialog's Keep both,
//     Replace and Skip each leave the disk as they say.
//  6. Target dropped on Favorites: pinned, still there after a reload, and
//     Remove from Favorites removes it; Add to Favorites in the row's ⋯ pins.
//     Dropped on a pin's top half, a folder is inserted above it, the
//     insertion line (not a ring) showing where while the drag rests.
//     Dropped on the lower half of the built-in Home, a folder goes in
//     between Home and Downloads — the line at Home's foot — and stays there
//     after a reload (the Favorites view's own row order). The row order this
//     run writes is restored at the end, like its config writes.
//  7. Screenshots of the selection and the drop highlight, light and dark.
//
// Usage:
//   ./singularity run plugins/apps/plugins/file-explorer/plugins/browser/e2e/select-and-move.ts \
//     [--out /tmp/select-and-move] [--headed]

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import {
  arg,
  boot,
  onBeforeFinish,
  openDeployDb,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out") ?? join(tmpdir(), "select-and-move");

const root = join(
  HOME_DIR,
  `.singularity-e2e-move-${Math.random().toString(36).slice(2, 8)}`,
);
const at = (...parts: string[]) => join(root, ...parts);
mkdirSync(at("Docs", "sub"), { recursive: true });
mkdirSync(at("Target"));
for (const name of ["a.txt", "b.txt", "c.txt"]) {
  writeFileSync(at(name), `${name}\n`);
}
writeFileSync(at("Target", "x.txt"), "old\n");
onBeforeFinish(async () => rmSync(root, { recursive: true, force: true }));

// The Places sidebar's manual row order (view-order's table) is DB data, not
// config, so the config revert ledger does not cover it: snapshot it now and
// put it back as it was at the end.
const PLACES_VIEW = "file-explorer.places";
const db = openDeployDb();
const savedOrder = await db.query<{
  view_id: string;
  row_key: string;
  rank: string;
}>(
  "SELECT view_id, row_key, rank FROM data_view_row_order WHERE data_view_id = $1",
  [PLACES_VIEW],
);
onBeforeFinish(async () => {
  await db.query("DELETE FROM data_view_row_order WHERE data_view_id = $1", [
    PLACES_VIEW,
  ]);
  for (const o of savedOrder) {
    await db.query(
      "INSERT INTO data_view_row_order (data_view_id, view_id, row_key, rank) VALUES ($1, $2, $3, $4)",
      [PLACES_VIEW, o.view_id, o.row_key, o.rank],
    );
  }
  await db.close();
});

const listingUrl = pathUrl(`/files/at/${encodeURIComponent(root)}`);

/** A tree row by its path (the listing is absolute, so are its ids). */
function row(page: Page, ...parts: string[]): Locator {
  return page.locator(`[data-tree-row][data-tree-id="${at(...parts)}"]`);
}

function selectedRows(page: Page): Promise<number> {
  return page.locator('[data-tree-row][aria-selected="true"]').count();
}

/** The Places sidebar row labelled `label`. */
function place(page: Page, label: string): Locator {
  return page
    .locator("[data-slot=sidebar-container]")
    .getByText(label, { exact: true })
    .first();
}

/** The Places sidebar's row labels, top to bottom. */
function sidebarOrder(page: Page): Promise<string[]> {
  return page
    .locator("[data-slot=sidebar-container] [data-row-key]")
    .evaluateAll((els) =>
      // A row's key marks its box and the row inside it: one label each.
      els
        .map((el) => el.textContent ?? "")
        .filter((t, i, all) => t !== all[i - 1]),
    );
}

async function openListing(page: Page): Promise<void> {
  await boot(page, listingUrl, { marker: "[data-tree-row]" });
  await row(page, "a.txt").or(row(page, "Docs")).first().waitFor();
}

/**
 * A native drag from `from` to `to` with the real mouse (Chromium drives
 * HTML5 drag and drop from it), resting `restMs` over the target before the
 * drop; `whileOver` runs during the rest.
 */
async function drag(
  page: Page,
  from: Locator,
  to: Locator,
  {
    restMs = 200,
    whileOver,
    atY = 0.5,
  }: {
    restMs?: number;
    whileOver?: () => Promise<void>;
    /** Where on the target the drop lands, as a fraction of its height. */
    atY?: number;
  } = {},
): Promise<void> {
  const src = await from.boundingBox();
  if (src === null) throw new Error("drag: the source is not on screen");
  await page.mouse.move(src.x + 40, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + 60, src.y + src.height / 2 + 4, { steps: 4 });
  const dst = await to.boundingBox();
  if (dst === null) throw new Error("drag: the target is not on screen");
  await page.mouse.move(dst.x + 40, dst.y + dst.height * atY, { steps: 8 });
  await page.waitForTimeout(restMs);
  if (whileOver) await whileOver();
  await page.mouse.up();
}

/** Wait for a disk condition (a move lands after its request). */
async function onDisk(check: () => boolean, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((res) => setTimeout(res, 100));
  }
  return check();
}

const r = report("file explorer: select, move and pin");

await withBrowser(async (h) => {
  for (const scheme of ["light", "dark"] as const) {
    const { page } = await h.session({
      viewport: { width: 1440, height: 900 },
      colorScheme: scheme,
    });
    await openListing(page);
    await row(page, "a.txt").click();
    await row(page, "c.txt").click({ modifiers: ["ControlOrMeta"] });
    await snap(page, out, `selection-${scheme}`);
    await drag(page, row(page, "a.txt"), row(page, "Docs"), {
      restMs: 300,
      whileOver: async () => {
        await snap(page, out, `drop-highlight-${scheme}`);
      },
    });
    // Put the two back where the next steps expect them.
    await onDisk(() => existsSync(at("Docs", "a.txt")));
    for (const name of ["a.txt", "c.txt"]) {
      if (existsSync(at("Docs", name))) {
        rmSync(at("Docs", name));
        writeFileSync(at(name), `${name}\n`);
      }
    }
  }

  const { page } = await h.session({ viewport: { width: 1440, height: 900 } });
  await openListing(page);

  // 1. No text selection across rows.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const aBox = await row(page, "a.txt").boundingBox();
  const cBox = await row(page, "c.txt").boundingBox();
  if (aBox === null || cBox === null) throw new Error("rows not on screen");
  await page.mouse.move(aBox.x + 30, aBox.y + aBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cBox.x + 200, cBox.y + cBox.height / 2, { steps: 10 });
  await page.mouse.up();
  const selectedText = await page.evaluate(
    () => window.getSelection()?.toString() ?? "",
  );
  r.ok(
    "dragging across rows selects no text",
    selectedText === "",
    JSON.stringify(selectedText),
  );
  await page.keyboard.press("Escape");

  // 2. Selection gestures.
  await row(page, "a.txt").click();
  r.ok("a click selects one row", (await selectedRows(page)) === 1);
  await row(page, "c.txt").click({ modifiers: ["ControlOrMeta"] });
  r.ok("⌘-click adds a row", (await selectedRows(page)) === 2);
  await row(page, "c.txt").click({ modifiers: ["ControlOrMeta"] });
  r.ok("⌘-click again removes it", (await selectedRows(page)) === 1);
  // A ⌘-click moves the anchor (to c, even unselecting it): start over at a.
  await row(page, "a.txt").click();
  await row(page, "c.txt").click({ modifiers: ["Shift"] });
  r.ok(
    "Shift-click selects the range a…c",
    (await selectedRows(page)) === 3,
    `${await selectedRows(page)} selected`,
  );
  const total = await page.locator("[data-tree-row]").count();
  await page.keyboard.press("ControlOrMeta+a");
  r.ok(
    "⌘A selects every row",
    (await selectedRows(page)) === total,
    `${await selectedRows(page)} of ${total}`,
  );
  r.ok(
    "the status bar counts the selection",
    await page.getByText(`${total} selected`).first().isVisible(),
  );
  await page.keyboard.press("Escape");

  // 3. Drag a + b onto the collapsed Docs: spring-open, then the move.
  await row(page, "a.txt").click();
  await row(page, "b.txt").click({ modifiers: ["Shift"] });
  r.ok("a and b selected", (await selectedRows(page)) === 2);
  r.ok(
    "Docs starts collapsed",
    (await row(page, "Docs").getAttribute("aria-expanded")) === "false",
  );
  let sameFolderHighlighted = false;
  let sprang = false;
  let notYet = false;
  await drag(page, row(page, "a.txt"), row(page, "Docs"), {
    restMs: 300,
    whileOver: async () => {
      notYet =
        (await row(page, "Docs").getAttribute("aria-expanded")) === "false";
      await page.waitForTimeout(900);
      sprang =
        (await row(page, "Docs").getAttribute("aria-expanded")) === "true";
    },
  });
  r.ok("Docs is still closed 300 ms into the hover", notYet);
  r.ok("Docs springs open after ~700 ms", sprang);
  r.ok(
    "a and b moved into Docs on disk",
    await onDisk(
      () =>
        existsSync(at("Docs", "a.txt")) &&
        existsSync(at("Docs", "b.txt")) &&
        !existsSync(at("a.txt")) &&
        !existsSync(at("b.txt")),
    ),
  );
  await row(page, "Docs", "a.txt").waitFor({ timeout: 5_000 });
  r.ok(
    "the listing shows them inside Docs",
    await row(page, "Docs", "b.txt").isVisible(),
  );
  r.ok(
    "moved rows left the selection",
    (await selectedRows(page)) === 0,
    `${await selectedRows(page)} selected`,
  );

  // 4. Docs onto its own child: no drop.
  // The drop landed inside Docs, so it stayed open: its child is on screen.
  await row(page, "Docs", "sub").waitFor({ timeout: 5_000 });
  await drag(page, row(page, "Docs"), row(page, "Docs", "sub"));
  await page.waitForTimeout(500);
  r.ok(
    "a folder onto its own child is no drop: Docs did not move",
    existsSync(at("Docs", "sub")) && !existsSync(at("Docs", "sub", "Docs")),
  );
  r.ok(
    "…and no refusal was needed",
    !(await page.getByText("cannot be moved into itself").first().isVisible()),
  );

  // Back where it was, and onto a sibling: both cancel, nothing moves.
  await page.keyboard.press("Escape");
  await drag(page, row(page, "Docs", "a.txt"), row(page, "Docs", "a.txt"));
  await drag(page, row(page, "Docs", "a.txt"), row(page, "Docs", "b.txt"), {
    whileOver: async () => {
      sameFolderHighlighted = await row(page, "Docs").evaluate((el) =>
        el.className.includes("ring-primary"),
      );
    },
  });
  await page.waitForTimeout(500);
  r.ok(
    "a.txt dropped on itself or its sibling stays in Docs",
    existsSync(at("Docs", "a.txt")) &&
      !existsSync(at("a.txt")) &&
      !existsSync(at("Docs", "b.txt", "a.txt")),
  );
  r.ok("…and Docs is not offered as a target", !sameFolderHighlighted);

  // A file row inside Docs, dragged onto from outside: into Docs.
  let folderHighlighted = false;
  await drag(page, row(page, "c.txt"), row(page, "Docs", "b.txt"), {
    whileOver: async () => {
      folderHighlighted = await row(page, "Docs").evaluate((el) =>
        el.className.includes("ring-primary"),
      );
      await snap(page, out, "drop-into-folder-of-file");
    },
  });
  r.ok("over Docs/b.txt, Docs is the highlighted target", folderHighlighted);
  r.ok(
    "c.txt dropped on Docs/b.txt moves into Docs",
    await onDisk(
      () => existsSync(at("Docs", "c.txt")) && !existsSync(at("c.txt")),
    ),
  );
  rmSync(at("Docs", "c.txt"));
  writeFileSync(at("c.txt"), "c.txt\n");

  // 5. Collisions: Keep both, Replace, Skip.
  for (const [answer, content] of [
    ["Keep both", "kept\n"],
    ["Replace", "new\n"],
    ["Skip", "skipped\n"],
  ] as const) {
    writeFileSync(at("x.txt"), content);
    await openListing(page);
    await row(page, "x.txt").waitFor();
    await drag(page, row(page, "x.txt"), row(page, "Target"));
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 5_000 });
    r.ok(
      `the dialog names the collision (${answer})`,
      await dialog.getByText("“x.txt” already exists in “Target”").isVisible(),
    );
    if (answer === "Keep both") await snap(page, out, "conflict-dialog");
    await dialog.getByRole("button", { name: answer, exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: 5_000 });
  }
  r.ok(
    "Keep both: the moved file is “x 2.txt”",
    (await onDisk(() => existsSync(at("Target", "x 2.txt")))) &&
      readFileSync(at("Target", "x 2.txt"), "utf8") === "kept\n",
  );
  r.ok(
    "Replace: Target/x.txt is the moved one",
    readFileSync(at("Target", "x.txt"), "utf8") === "new\n",
  );
  r.ok(
    "Skip: x.txt stays where it was",
    existsSync(at("x.txt")) &&
      readFileSync(at("x.txt"), "utf8") === "skipped\n",
  );

  // 6. Favorites.
  await openListing(page);
  await drag(page, row(page, "Target"), place(page, "Home"));
  r.ok(
    "Target dropped on Favorites is pinned",
    await place(page, "Target")
      .waitFor({ timeout: 5_000 })
      .then(() => true)
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "TimeoutError") return false;
        throw err;
      }),
  );
  await page.reload();
  await openListing(page);
  r.ok("the pin survives a reload", await place(page, "Target").isVisible());
  await snap(page, out, "pinned");
  await place(page, "Target").hover();
  await page
    .getByRole("button", { name: "Remove from Favorites" })
    .first()
    .click();
  await place(page, "Target").waitFor({ state: "hidden", timeout: 5_000 });
  r.ok(
    "Remove from Favorites unpins it",
    !(await place(page, "Target").isVisible()),
  );

  await row(page, "c.txt").hover();
  await row(page, "c.txt")
    .getByRole("button", { name: "More", exact: true })
    .click();
  await page.getByRole("button", { name: "Add to Favorites" }).first().click();
  await page.keyboard.press("Escape");
  r.ok(
    "Add to Favorites in the ⋯ menu pins a file",
    await place(page, "c.txt")
      .waitFor({ timeout: 5_000 })
      .then(() => true)
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "TimeoutError") return false;
        throw err;
      }),
  );
  // The app launcher can be left open over the sidebar by the menu's focus
  // return; park the pointer on the listing and close it.
  await page.mouse.move(900, 600);
  const launcher = page.locator("[data-base-ui-portal]").getByText("All apps");
  if ((await launcher.count()) > 0) {
    await page.keyboard.press("Escape");
    await launcher.first().waitFor({ state: "hidden", timeout: 5_000 });
  }
  // Dropped on the top half of the pinned c.txt, Docs goes in above it,
  // the insertion line showing where (never the into-ring).
  let line = false;
  let ring = true;
  await drag(page, row(page, "Docs"), place(page, "c.txt"), {
    atY: 0.2,
    whileOver: async () => {
      const sidebar = page.locator("[data-slot=sidebar-container]");
      line = (await sidebar.locator(".bg-primary.h-\\[2px\\]").count()) > 0;
      ring = (await sidebar.locator(".ring-primary\\/40").count()) > 0;
      await snap(page, out, "favorites-insert-line");
    },
  });
  r.ok("over a pin, the insertion line shows", line);
  r.ok("…and no row is ringed as a drop-into target", !ring);
  await place(page, "Docs").waitFor({ timeout: 5_000 });
  const order = await sidebarOrder(page);
  const iDocs = order.findIndex((t) => t.includes("Docs"));
  const iC = order.findIndex((t) => t.includes("c.txt"));
  r.ok(
    "Docs is pinned just above c.txt",
    iDocs !== -1 && iDocs + 1 === iC,
    JSON.stringify(order),
  );

  // Dropped on the lower half of the built-in Home, Target goes in between
  // Home and Downloads: the line at Home's foot, and the pin there for good.
  let lineAtHome = false;
  await drag(page, row(page, "Target"), place(page, "Home"), {
    atY: 0.8,
    whileOver: async () => {
      const sidebar = page.locator("[data-slot=sidebar-container]");
      const lineBox = await sidebar
        .locator(".bg-primary.h-\\[2px\\]")
        .first()
        .boundingBox();
      const home = await place(page, "Home").boundingBox();
      const downloads = await place(page, "Downloads").boundingBox();
      lineAtHome =
        lineBox !== null &&
        home !== null &&
        downloads !== null &&
        lineBox.y > home.y + home.height / 2 &&
        lineBox.y < downloads.y + downloads.height / 2;
      await snap(page, out, "favorites-insert-after-home");
    },
  });
  r.ok("over Home's lower half, the line shows at Home's foot", lineAtHome);
  await place(page, "Target").waitFor({ timeout: 5_000 });
  const between = (labels: readonly string[]) => {
    const iHome = labels.findIndex((t) => t.includes("Home"));
    const iTarget = labels.findIndex((t) => t.includes("Target"));
    const iDownloads = labels.findIndex((t) => t.includes("Downloads"));
    return iHome !== -1 && iTarget === iHome + 1 && iDownloads === iHome + 2;
  };
  const dropped = await sidebarOrder(page);
  r.ok(
    "Target is pinned between Home and Downloads",
    between(dropped),
    JSON.stringify(dropped),
  );
  await page.reload();
  await openListing(page);
  await place(page, "Target").waitFor({ timeout: 5_000 });
  const reloaded = await sidebarOrder(page);
  r.ok(
    "…and is still there after a reload",
    between(reloaded),
    JSON.stringify(reloaded),
  );

  await page.mouse.move(900, 600);
  await place(page, "c.txt").click();
  await page.waitForTimeout(800);
  r.ok(
    "a pinned file opens its folder with the file previewed",
    decodeURIComponent(page.url()).includes("c.txt"),
    page.url(),
  );

  await r.finish();
});
