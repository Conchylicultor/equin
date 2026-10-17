/**
 * The workspace menu's hover card: hovering a row shows ONE card, beside the
 * menu (not over it), its top level with the hovered row, holding the
 * capability chips — and moving to another row moves the card with it.
 *
 * Drives the draft popover from the task detail's "+ Prerequisite" button (a
 * plain always-mounted trigger), then the Workspace pill on its bar.
 *
 *   ./singularity run plugins/conversations/plugins/workspace/plugins/launch-option/e2e/workspace-card-verify.ts \
 *     --task <taskId> [--out /tmp/ws-card] [--headed]
 */
import {
  arg,
  boot,
  clearToasts,
  ELEMENT_TIMEOUT_MS,
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Locator, Page } from "playwright";

const out = arg("out") ?? "/tmp/ws-card";
const taskId = requireArg(
  "task",
  "workspace-card-verify.ts --task <taskId> [--out <prefix>] [--headed]",
);

const r = report("workspace menu hover card");

await withBrowser(async (h) => {
  const { page } = await h.session();
  await boot(page, pathUrl(`/agents/tasks/t/${taskId}`), { settleMs: 3000 });
  await clearToasts(page);
  await page
    .getByRole("button", { name: "+ Prerequisite" })
    .click({ timeout: 15_000 });
  await page
    .getByRole("button", { name: "Create task" })
    .waitFor({ state: "visible", timeout: 15_000 });
  await clearToasts(page);

  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  const menu = page.getByRole("menu");
  await menu.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  const rows = menu.getByRole("menuitem");
  r.ok("workspace menu lists rows", (await rows.count()) > 0);

  for (let i = 0; i < Math.min(await rows.count(), 2); i++) {
    await checkRow(page, menu, rows.nth(i), i);
  }
});

async function checkRow(
  page: Page,
  menu: Locator,
  row: Locator,
  i: number,
): Promise<void> {
  const name = (await row.innerText()).split("\n")[0];
  // Hover the wrapper's centre — a disabled row passes the hover through.
  await row.hover({ force: true });
  const card = page.locator('[data-slot="tooltip-card"]');
  await card.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  await page.waitForTimeout(300);
  await snap(page, out, `row-${i}`);

  r.eq(`"${name}": one card open`, await card.count(), 1);
  const m = await menu.boundingBox();
  const c = await card.boundingBox();
  const rb = await row.boundingBox();
  if (!m || !c || !rb) {
    r.ok(`"${name}": card, menu and row are laid out`, false);
    return;
  }
  r.ok(
    `"${name}": card sits beside the menu, not over it`,
    c.x >= m.x + m.width - 1 || c.x + c.width <= m.x + 1,
    `menu ${m.x}..${m.x + m.width}, card ${c.x}..${c.x + c.width}`,
  );
  // Top level with the row — or, where that would run off the screen, the
  // alignment flips and the card's BOTTOM is level with the row's.
  const topLevel = Math.abs(c.y - rb.y) <= 2;
  const bottomLevel = Math.abs(c.y + c.height - (rb.y + rb.height)) <= 2;
  r.ok(
    `"${name}": card is level with the row`,
    topLevel || bottomLevel,
    `row ${rb.y}..${rb.y + rb.height}, card ${c.y}..${c.y + c.height}`,
  );
  r.ok(
    `"${name}": card lists the capabilities`,
    (await card.getByText("DB fork", { exact: true }).count()) === 1,
  );
}
