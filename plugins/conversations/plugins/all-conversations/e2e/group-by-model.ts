/**
 * All-conversations grouped by Model lists EVERY model with its exact count —
 * server sections (research/2026-10-08-primitives-data-view-live-server-sections.md),
 * not the sections the first loaded page happens to hold:
 *
 *  1. opens the pane and groups the active view by Model through the View
 *     settings control (the same click a user makes);
 *  2. reads the group headers: more than one model, each with a count;
 *  3. screenshots it (`<out>-grouped.png`), scrolls to the end
 *     (`<out>-scrolled.png`);
 *  4. puts the view back ungrouped (also on failure), so the run leaves the
 *     config as it found it.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/conversations/plugins/all-conversations/e2e/group-by-model.ts [--out /tmp/group-by-model] [--headed]
 */
import type { Locator, Page } from "playwright";
import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/group-by-model";

/** The first element of any of `roles` named exactly `name`, polled until it shows. */
async function clickable(
  page: Page,
  name: string | RegExp,
  roles: readonly (
    "button" | "radio" | "menuitemradio" | "option" | "menuitem"
  )[],
): Promise<Locator> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const role of roles) {
      const candidate = page.getByRole(role, {
        name,
        exact: typeof name === "string",
      });
      if ((await candidate.count()) > 0) return candidate.first();
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`nothing clickable named ${String(name)}`);
}

/** Group the active view by `field` (or `None`) through the View settings panel. */
async function groupBy(page: Page, field: string): Promise<void> {
  await (await clickable(page, /^View settings/, ["button"])).click();
  await (
    await clickable(page, field, ["menuitemradio", "radio", "option", "button"])
  ).click();
  await page.keyboard.press("Escape");
}

await withBrowser(async (h) => {
  const r = report("all-conversations — grouped by Model");
  const { page } = await h.session({ viewport: { width: 1400, height: 1000 } });
  await page.goto(pathUrl("/agents/all-conversations"));
  await page.waitForTimeout(3000);
  try {
    await groupBy(page, "Model");
    await page.waitForTimeout(3000);
    // A group header is the collapsible trigger the grouped table draws per
    // section (`aria-expanded`), its label then its count.
    const headers = (await page.locator("[aria-expanded]").allInnerTexts()).map(
      (t) => t.replace(/\s+/g, " ").trim(),
    );
    console.log("group headers:", headers);
    r.ok(
      "more than one model section is listed",
      headers.filter((t) => /\d/.test(t)).length > 1,
      headers.join(" | "),
    );
    await snap(page, OUT, "grouped");
    await page.mouse.wheel(0, 20_000);
    await page.waitForTimeout(2500);
    await snap(page, OUT, "scrolled");
  } finally {
    await page.mouse.wheel(0, -20_000);
    await groupBy(page, "None");
    await page.waitForTimeout(1000);
  }
  await r.finish();
});
