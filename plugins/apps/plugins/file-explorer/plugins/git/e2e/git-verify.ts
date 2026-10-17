// The file explorer's git awareness, end to end on a deployed build of a
// worktree (the checkout this script runs from is the git checkout it browses).
//
//  1. /files at the checkout root: rows carry git badges, and a file touched
//     now shows "?" without a reload (the watcher pushes the status).
//  2. A file modified vs main shows M; opening it offers a Diff tab that renders.
//  3. node_modules is hidden until "Show ignored files" is on.
//  4. The "Changed vs main" filter narrows the rows.
//  5. A conversation's File explorer opens the browser at its worktree, and
//     Up stops at that root.
//  6. Regressions: a file peek renders; Studio's plugin Files section lists files.
//
// Usage:
//   ./singularity run plugins/apps/plugins/file-explorer/plugins/git/e2e/git-verify.ts \
//     [--out /tmp/git-verify] [--headed]

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Locator, Page } from "playwright";
import {
  arg,
  boot,
  openDeployDb,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

const out = arg("out") ?? join(tmpdir(), "git-verify");

const root = await getWorktreeRoot(import.meta.dir);
/** Untracked, not hidden (a dot-file would sit behind Show hidden files). */
const PROBE = "e2e-git-probe.txt";
const probePath = join(root, PROBE);
/** A tracked file this branch leaves alone, edited and restored to see a push. */
const LIVE_FILE = "CITATION.cff";
const livePath = join(root, LIVE_FILE);
const liveOriginal = readFileSync(livePath, "utf8");
/** Modified on this branch vs main. */
const MODIFIED_DIR =
  "plugins/apps/plugins/file-explorer/plugins/browser/web/components";
const MODIFIED_FILE = "file-browser.tsx";

function filesAt(dir: string, open?: string): string {
  const tail = open === undefined ? "" : `/${encodeURIComponent(open)}`;
  return pathUrl(`/files/at/${encodeURIComponent(dir)}${tail}`);
}

/** A tree row by its entry name (its id is its path, so the last segment). */
function row(scope: Page | Locator, name: string): Locator {
  return scope.locator(`[data-tree-row][data-tree-id$="/${name}"]`).first();
}

async function visible(l: Locator, timeout = 10_000): Promise<boolean> {
  try {
    await l.waitFor({ state: "visible", timeout });
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") return false;
    throw err;
  }
}

async function hidden(l: Locator, timeout = 10_000): Promise<boolean> {
  try {
    await l.waitFor({ state: "hidden", timeout });
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") return false;
    throw err;
  }
}

const badge = (r: Locator, title: string) => r.locator(`[data-tooltip="${title}"]`);

const r = report("file explorer git");

const db = openDeployDb();
const convRows = await db.query<{ id: string; worktree_path: string }>(
  `SELECT id, worktree_path FROM conversations_v
    WHERE worktree_path = $1 ORDER BY created_at DESC LIMIT 1`,
  [root],
);
await db.close();

try {
  await withBrowser(async (h) => {
    const { page } = await h.session({
      viewport: { width: 1600, height: 960 },
    });

    // 1. The checkout root: the probe (made before the listing — a listing is
    //    read once per visit) shows ?, then a clean tracked file edited now
    //    turns M with no reload.
    writeFileSync(probePath, "probe\n");
    await boot(page, filesAt(root), { marker: "[data-tree-row]" });
    r.ok("root lists rows", await visible(row(page, "plugins")));
    r.ok(
      "a folder holding changes carries the dot",
      await visible(badge(row(page, "plugins"), "Contains changes")),
    );
    r.ok(
      "an untracked file shows ?",
      await visible(badge(row(page, PROBE), "Untracked"), 15_000),
    );
    r.ok(
      `${LIVE_FILE} starts clean`,
      (await badge(row(page, LIVE_FILE), "Modified").count()) === 0,
    );
    await snap(page, out, "1-root");
    writeFileSync(livePath, `${liveOriginal}\n`);
    r.ok(
      `${LIVE_FILE} edited now shows M without a reload (watcher push)`,
      await visible(badge(row(page, LIVE_FILE), "Modified"), 15_000),
    );
    await snap(page, out, "1b-live-modified");
    writeFileSync(livePath, liveOriginal);
    r.ok(
      `${LIVE_FILE} restored goes clean again`,
      await hidden(badge(row(page, LIVE_FILE), "Modified"), 15_000),
    );

    // 3. Ignored files.
    r.ok(
      "node_modules is hidden by default",
      (await row(page, "node_modules").count()) === 0,
    );
    const showIgnored = page.getByRole("button", {
      name: "Show ignored files",
    });
    r.ok("the Show ignored files toggle is there", await visible(showIgnored));
    await showIgnored.click();
    r.ok(
      "node_modules shows once toggled",
      await visible(row(page, "node_modules")),
    );
    await snap(page, out, "3-ignored-shown");
    await page.getByRole("button", { name: "Hide ignored files" }).click();
    r.ok("node_modules hides again", await hidden(row(page, "node_modules")));

    // 4. Changed vs main, through the tree's options trigger — the "View
    //    options" in the explorer's own toolbar (the global action bar has one
    //    too, and which comes first in the DOM depends on the surface mode).
    const before = await page.locator("[data-tree-row]").count();
    await page.locator("[data-tree-row]").first().hover();
    await page
      .getByRole("button", { name: "Enclosing folder" })
      .first()
      .locator("xpath=..")
      .getByRole("button", { name: "View options" })
      .click();
    const panel = page.getByRole("dialog");
    await panel.getByText("Filter", { exact: true }).click();
    await panel.getByRole("button", { name: "Changed vs main" }).click();
    // The new rule reads "Changed vs main is ☐"; tick it.
    await panel.getByRole("checkbox").last().click();
    await page.waitForTimeout(800);
    await snap(page, out, "4-changed-vs-main");
    const after = await page.locator("[data-tree-row]").count();
    r.ok(
      "Changed vs main narrows the rows",
      after > 0 && after < before,
      `${before} → ${after}`,
    );
    r.ok(
      "it keeps the changed folders and drops clean ones",
      (await row(page, "plugins").count()) === 1 &&
        (await row(page, "gateway").count()) === 0,
    );
    await panel.getByText("Clear filter").click();
    await page.keyboard.press("Escape");
    // The view's config write-back is debounced: let it land before leaving,
    // or the filter outlives this step (the Studio Files section in 7b shares
    // the explorer tree's views).
    await page.waitForTimeout(1500);

    // 2. A file modified vs main, opened.
    await page.goto(filesAt(join(root, MODIFIED_DIR)));
    const modRow = row(page, MODIFIED_FILE);
    r.ok("the modified file is listed", await visible(modRow, 20_000));
    r.ok("it shows M", await visible(badge(modRow, "Modified"), 15_000));
    await modRow.click();
    const diffTab = page.getByRole("tab", { name: "Diff" });
    r.ok("its preview offers a Diff tab", await visible(diffTab));
    await diffTab.click();
    r.ok(
      "the Diff tab renders a diff",
      await visible(page.locator(".diff-view").first(), 20_000),
    );
    await snap(page, out, "2-diff");

    // 5. A conversation's explorer.
    const conv = convRows[0];
    if (conv === undefined) {
      r.ok("a conversation runs in this worktree", false);
    } else {
      await boot(page, pathUrl(`/agents/c/${conv.id}`), { settleMs: 1500 });
      await page
        .locator('button[aria-label="File explorer"][aria-pressed]')
        .click();
      const pane = page.locator("[data-tree-row]").first();
      r.ok("the conversation explorer lists rows", await visible(pane, 20_000));
      r.ok(
        "it is rooted at the worktree",
        (await visible(row(page, "plugins"))) &&
          (await page
            .getByRole("button", { name: "Enclosing folder" })
            .first()
            .isDisabled()),
        "Up must be disabled at the root",
      );
      await snap(page, out, "6-conv-explorer");
      // Into a folder, Up returns, and stops at the root.
      await row(page, "plugins").dblclick();
      r.ok("double-click enters plugins/", await visible(row(page, "apps")));
      const up = page.getByRole("button", { name: "Enclosing folder" }).first();
      await up.click();
      r.ok("Up returns to the root", await visible(row(page, "plugins")));
      r.ok("Up stops at the root", await up.isDisabled());
      await snap(page, out, "6b-conv-up");

      // 7a. A file peek from the conversation.
      await boot(
        page,
        pathUrl(
          `/agents/c/${conv.id}/file/${encodeURIComponent(basename(conv.worktree_path))}/package.json`,
        ),
        { settleMs: 1500 },
      );
      r.ok(
        "a file peek renders the file",
        await visible(page.getByText('"workspaces"').first(), 20_000),
      );
      await snap(page, out, "7a-file-peek");
    }

    // 7b. Studio's plugin Files section (collapsed until opened).
    await boot(page, pathUrl("/studio/p/apps.file-explorer.git"), {
      settleMs: 1500,
    });
    await page.getByText("Files", { exact: true }).first().click();
    r.ok(
      "the plugin Files section lists its files",
      await visible(row(page, "CLAUDE.md"), 20_000),
    );
    r.ok(
      "it is rooted at the plugin (Up disabled)",
      await page
        .getByRole("button", { name: "Enclosing folder" })
        .first()
        .isDisabled(),
    );
    await snap(page, out, "7b-studio-files");
    await row(page, "CLAUDE.md").click();
    r.ok(
      "opening a file there peeks it",
      // A heading of the plugin's CLAUDE.md, which the detail page itself
      // never shows (its description it does — so not that).
      await visible(
        page.getByRole("heading", { name: "Plugin reference" }).first(),
        20_000,
      ),
    );
    await snap(page, out, "7c-studio-file-open");
  });
} finally {
  rmSync(probePath, { force: true });
  writeFileSync(livePath, liveOriginal);
}

await r.finish();
