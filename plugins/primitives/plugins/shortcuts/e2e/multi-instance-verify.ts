// Two copies of the same app mounted at once (every open tab stays mounted,
// hidden with display:none) must not react to each other's keystrokes or take
// each other's pending focus.
//
//   1. ⌘B toggles ONLY the visible tab's sidebar — the hidden tab's keeps its
//      state. (The ui-kit sidebar used a page-wide listener and toggled both.)
//   2. "Add child" in a tree puts the cursor in the new row of THAT tree, with a
//      second copy of the same tree mounted in a hidden tab. (The tree's "focus
//      this row next" note used to be one page-wide variable.)
//
// Creates one task in THIS worktree's database per run.
//
// Usage:
//   ./equin run plugins/primitives/plugins/shortcuts/e2e/multi-instance-verify.ts [--headed]

import {
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";

const OUT = "/tmp/multi-instance";
const r = report("same app mounted twice");

/** Every mounted sidebar's state, and whether it is on screen. */
async function sidebars(
  page: Page,
): Promise<{ state: string; visible: boolean }[]> {
  return page.locator('[data-slot="sidebar"][data-state]').evaluateAll((els) =>
    els.map((el) => ({
      state: el.getAttribute("data-state") ?? "",
      visible: el.checkVisibility(),
    })),
  );
}

/**
 * Open a second Agent Manager tab on its tasks list: "+" in the tab bar opens a
 * Home tab, Home's launcher turns it into an Agent Manager tab, and its own
 * sidebar's Tasks link lands it on the tasks tree. The first tab stays mounted,
 * hidden.
 */
async function openSecondTasksTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New tab" }).click();
  // The LAST visible match is Home's launcher tile — the first is the existing
  // tab's own label in the tab bar, which would just switch back to it.
  await page
    .getByRole("button", { name: "Agent Manager" })
    .filter({ visible: true })
    .last()
    .click();
  await page
    .locator('[data-slot="sidebar"]')
    .filter({ visible: true })
    .getByText("Tasks", { exact: true })
    .click();
}

await withBrowser(async (h) => {
  const { page } = await h.session();

  await page.goto(pathUrl("/agents/tasks"));
  await page.locator('[data-slot="sidebar"][data-state]').first().waitFor();
  await openSecondTasksTab(page);

  const mounted = await waitFor(
    () => sidebars(page),
    (s) => s.length >= 2 && s.filter((x) => x.visible).length === 1,
    { timeoutMs: 20_000 },
  );
  r.ok(
    "two sidebars mounted, one visible",
    mounted.ok,
    JSON.stringify(mounted.value),
  );
  await snap(page, OUT, "1-two-tabs");

  // ── 1. ⌘B ─────────────────────────────────────────────────────────────
  // Focus the page body so no editor claims the keystroke.
  await page.locator("body").click({ position: { x: 700, y: 450 } });
  const before = await sidebars(page);
  await page.keyboard.press("ControlOrMeta+b");
  const after = await waitFor(
    () => sidebars(page),
    (s) => s.some((x, i) => x.visible && x.state !== before[i]?.state),
    { timeoutMs: 5_000 },
  );
  const visibleIdx = before.findIndex((x) => x.visible);
  r.ok(
    "⌘B toggles the visible tab's sidebar",
    after.value[visibleIdx]?.state !== before[visibleIdx]?.state,
    `before=${JSON.stringify(before)} after=${JSON.stringify(after.value)}`,
  );
  r.ok(
    "⌘B leaves every hidden tab's sidebar alone",
    // Vacuous without a hidden copy — require one, so a failed setup can't pass.
    before.some((x) => !x.visible) &&
      before.every((x, i) => x.visible || after.value[i]?.state === x.state),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after.value)}`,
  );
  await snap(page, OUT, "2-after-cmd-b");
  // Put it back so the tree below is on screen.
  await page.keyboard.press("ControlOrMeta+b");

  // ── 2. Add child → focus lands in THIS tree ──────────────────────────
  // The "+" is hover-revealed (no pointer events until its row is hovered), so
  // move the mouse onto where it sits first, then click it.
  const addChild = page
    .getByRole("button", { name: "Add child" })
    .filter({ visible: true })
    .first();
  const box = await addChild.boundingBox();
  if (!box) throw new Error("no visible Add child button on the tasks tree");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await addChild.click();
  const focused = await waitFor(
    () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return {
          tag: el?.tagName ?? null,
          editable:
            !!el &&
            (el.isContentEditable ||
              el.tagName === "INPUT" ||
              el.tagName === "TEXTAREA"),
          visible: el ? el.checkVisibility() : false,
        };
      }),
    (f) => f.editable,
    { timeoutMs: 15_000 },
  );
  r.ok(
    "after Add child, a text field has focus",
    focused.ok,
    JSON.stringify(focused.value),
  );
  r.ok(
    "…and it is in the visible tab's tree",
    focused.value.visible,
    JSON.stringify(focused.value),
  );
  await snap(page, OUT, "3-after-add-child");
});

await r.finish();
