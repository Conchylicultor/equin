/**
 * Every card in a draft chain carries the action slot — not only the head.
 *
 * A `TaskDraftFormSlots.Action` button (the element picker) writes into the
 * editor of the card it is rendered in, so each card needs its own. The slot
 * was head-card-only for as long as there was a `HeadToolbar` to hang it off,
 * which meant adding a second task left you with no way to attach an element to
 * it. A type-check cannot see that — the gate was one boolean in the card's bar
 * — so it is asserted here.
 *
 * What makes this a real check is counting the buttons AFTER adding a card.
 * Asserting only that the head has one passes just as happily with the gate put
 * back, since the head always had it.
 *
 * It then walks the chain chrome, whose controls are all things a type-check
 * cannot see either:
 *
 * - each card has a drag grip once there are two, and the head has no
 *   connector above it;
 * - a connector's "Insert a task here" / unlink / "Remove task N" act on the
 *   right card, and the unlinked row says so in words;
 * - a focused grip reorders from the keyboard (Space, ↑, Space);
 * - the header × removes task 1 while there is a chain (the next card inherits
 *   the Dependency pill) and closes the popover once there is one task;
 * - the prerequisite "Standalone" option lives inside the Dependency menu, and
 *   ticking it leaves the menu open.
 *
 * Drives the popover from the task detail's "+ Prerequisite" button rather than
 * the Improve toolbar button: same `TaskDraftPopover`, but a plain
 * always-mounted trigger instead of one behind the floating action bar's
 * hover-disclosure animation. `--task` must name a task that already has at
 * least one dependency — the Standalone option is only offered then.
 *
 *   ./equin run plugins/tasks/plugins/task-draft-form/e2e/card-actions-verify.ts \
 *     --task <taskId> [--headed]
 */
import {
  arg,
  boot,
  clearToasts,
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";

const out = arg("out") ?? "/tmp/draft-card-actions";
/**
 * The picker's accessible name. It is deliberately the SAME whether or not an
 * element is attached, so this locator cannot go stale by someone picking one.
 */
const PICKER = "Attach UI element";
const taskId = requireArg(
  "task",
  "card-actions-verify.ts --task <taskId> [--out <prefix>] [--headed]",
);

const r = report("draft card actions on every card");

/** The editable field of the card at `index` (0 = head). */
const field = (page: Page, index: number) =>
  page.locator(`[data-card-index="${index}"] [contenteditable="true"]`);
const cardCount = (page: Page) => page.locator("[data-card-index]").count();
const cardText = async (page: Page, index: number) =>
  (await field(page, index).innerText()).trim();
const typeInto = async (page: Page, index: number, text: string) => {
  await field(page, index).click();
  await page.keyboard.type(text);
};

await withBrowser(async (h) => {
  const { page } = await h.session();
  await boot(page, pathUrl(`/agents/tasks/t/${taskId}`), { settleMs: 3000 });

  await page
    .getByRole("button", { name: "+ Prerequisite" })
    .click({ timeout: 15_000 });
  // Wait on the submit button, NOT on the editor placeholder: the editor is
  // Lexical, whose placeholder is an overlay element and not a `placeholder`
  // attribute — so `getByPlaceholder` never matches and would look like the
  // popover never opened. Its name also carries the ⌘↵ hint, hence the prefix.
  const submit = page.getByRole("button", { name: /^Create (task|\d+ tasks)/ });
  await submit.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(800);
  // The header ×'s "Close" is scoped to the popover: the task pane behind it
  // has a "Close" button of its own.
  const popover = page.locator('[data-slot="popover-content"]');
  const close = popover.getByRole("button", { name: "Close", exact: true });

  // The draft is persisted, so a previous run may have left a chain behind.
  // Start from one empty card.
  const removeFirst = page.getByRole("button", {
    name: "Remove task 1",
    exact: true,
  });
  while ((await removeFirst.count()) > 0) {
    await removeFirst.click();
    await page.waitForTimeout(200);
  }
  await field(page, 0).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await snap(page, out, "one-card");

  const pickers = page.getByRole("button", { name: PICKER, exact: true });
  r.eq("the head card carries the picker", await pickers.count(), 1);
  const grips = page.getByRole("button", { name: "Drag to reorder" });
  r.eq("a lone card has no grip", await grips.count(), 0);
  r.eq("with one card the header × closes", await close.count(), 1);
  await typeInto(page, 0, "alpha");

  // A toast lands in the same corner as the controls below, and Playwright's
  // retry holds the pointer over it so it never expires — see `clearToasts`.
  await clearToasts(page);
  const addFollowUp = page.getByRole("button", {
    name: "Follow-up task",
    exact: true,
  });
  await addFollowUp.click({ timeout: 15_000 });
  await page.waitForTimeout(800);
  await snap(page, out, "two-cards");

  // The claim: the second card got one too. Under the old head-only gate this
  // is still 1.
  r.eq("adding a card adds a picker", await pickers.count(), 2);

  await addFollowUp.click();
  await page.waitForTimeout(300);
  await typeInto(page, 1, "bravo");
  await typeInto(page, 2, "charlie");
  const inserts = page.getByRole("button", { name: "Insert a task here" });
  r.eq("three cards → three grips", await grips.count(), 3);
  r.eq(
    "the head has no connector (one per later card)",
    await inserts.count(),
    2,
  );
  await snap(page, out, "three-cards");

  await inserts.first().click();
  await page.waitForTimeout(300);
  r.eq("insert on connector 1 adds a card", await cardCount(page), 4);
  r.eq("the inserted card sits at index 1", await cardText(page, 1), "");
  r.eq("the old card 2 moved to index 2", await cardText(page, 2), "bravo");

  await page
    .getByRole("button", { name: "Remove task 2", exact: true })
    .click();
  await page.waitForTimeout(300);
  r.eq(
    "remove on connector 1 drops the card below it",
    await cardCount(page),
    3,
  );
  r.eq("…which was the inserted one", await cardText(page, 1), "bravo");

  await page
    .getByRole("button", { name: "Unlink tasks (run in parallel)" })
    .nth(1)
    .click();
  await page.waitForTimeout(300);
  r.ok(
    "unlinked connector 2 says it runs in parallel",
    await page
      .getByText("In parallel — doesn't wait for task 2", { exact: true })
      .isVisible(),
  );
  await snap(page, out, "unlinked");

  // Pointer drag keeps the card's shape. Without a DragOverlay, dnd-kit scales
  // the dragged item to the rect it is over; a card serialized with
  // `CSS.Transform` was squashed onto its shorter neighbour. Make card 3 tall,
  // drag it over the one-line card 2, measure mid-drag, then carry it back
  // and drop it where it started, so the order the rest of the script asserts
  // is untouched. (Not Escape: that would also dismiss the popover.)
  await field(page, 2).click();
  await page.keyboard.press("End");
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(`line ${i}`);
  }
  const tall = page.locator('[data-card-index="2"]');
  const restHeight = (await tall.boundingBox())!.height;
  const shortHeight = (await page
    .locator('[data-card-index="1"]')
    .boundingBox())!.height;
  r.ok(
    "card 3 is taller than card 2 before the drag",
    restHeight > shortHeight + 20,
  );
  const grip = (await grips.nth(2).boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  // Past the 4px activation distance, then onto card 2's centre.
  const target = (await page.locator('[data-card-index="1"]').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y - 10, { steps: 4 });
  await page.mouse.move(grip.x + grip.width / 2, target.y + target.height / 2, {
    steps: 8,
  });
  await page.waitForTimeout(300);
  await snap(page, out, "mid-drag");
  const dragged = await tall.evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return {
      scaleX: m.a,
      scaleY: m.d,
      height: el.getBoundingClientRect().height,
    };
  });
  r.eq("mid-drag: no vertical scale on the dragged card", dragged.scaleY, 1);
  r.eq("mid-drag: no horizontal scale on the dragged card", dragged.scaleX, 1);
  r.ok(
    `mid-drag: the dragged card keeps its height (${restHeight} → ${dragged.height})`,
    Math.abs(dragged.height - restHeight) < 1,
  );
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2, {
    steps: 8,
  });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(400);
  r.eq(
    "dropped in place: bravo is still second",
    await cardText(page, 1),
    "bravo",
  );

  // Keyboard reorder: dnd-kit's KeyboardSensor on the focused grip.
  await grips.nth(1).focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(200);
  await page.keyboard.press("Space");
  await page.waitForTimeout(400);
  r.eq("keyboard move: bravo is now first", await cardText(page, 0), "bravo");
  r.eq("keyboard move: alpha is now second", await cardText(page, 1), "alpha");

  const dependency = page.getByRole("button", {
    name: "Relation to current task",
  });
  await removeFirst.click();
  await page.waitForTimeout(300);
  r.eq("header × with a chain removes task 1", await cardCount(page), 2);
  r.eq("…and the next card becomes the head", await cardText(page, 0), "alpha");
  r.eq(
    "the new head carries the Dependency pill",
    await page
      .locator('[data-card-index="0"]')
      .getByRole("button", { name: "Relation to current task" })
      .count(),
    1,
  );
  r.eq("…and only it does", await dependency.count(), 1);

  await removeFirst.click();
  await page.waitForTimeout(300);
  r.eq("header × again leaves one card", await cardCount(page), 1);
  r.eq("with one card left the header × reads Close", await close.count(), 1);

  // The prerequisite's Standalone option lives in the Dependency menu.
  await dependency.click();
  await page.getByRole("menuitem", { name: "As prerequisite" }).click();
  await page.waitForTimeout(300);
  if (!(await page.getByRole("menu").isVisible())) {
    await dependency.click();
  }
  const standaloneBox = page.getByRole("menuitemcheckbox", {
    name: "Standalone — don't inherit existing dependencies",
  });
  await standaloneBox.waitFor({ state: "visible", timeout: 5_000 });
  r.ok(
    "prerequisite shows the Options group",
    await page
      .getByRole("menu")
      .getByText("Options", { exact: true })
      .isVisible(),
  );
  await standaloneBox.click();
  await page.waitForTimeout(300);
  r.ok(
    "ticking Standalone keeps the menu open",
    await standaloneBox.isVisible(),
  );
  r.eq(
    "…and the box is checked",
    await standaloneBox.getAttribute("aria-checked"),
    "true",
  );
  await snap(page, out, "standalone");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await close.click();
  await page.waitForTimeout(400);
  r.ok("Close shuts the popover", !(await submit.isVisible()));
});

await r.finish();
