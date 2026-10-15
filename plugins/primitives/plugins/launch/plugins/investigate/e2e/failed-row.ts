/**
 * Verifies the Investigate action on a failed row: hovering a failed run in a
 * list reveals the one Investigate button (bug-report icon), and clicking it
 * opens the launch popover titled "Investigate this failed …". Launches
 * nothing — it only opens the popover.
 *
 * Manual only. Run after `./singularity build`:
 *   ./singularity run plugins/primitives/plugins/launch/plugins/investigate/e2e/failed-row.ts \
 *     [--path /debug/background/activity/job/backup.run.supervised] [--out /tmp/investigate] [--headed]
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const PATH = arg(
  "path",
  "/debug/background/activity/job/backup.run.supervised",
);
const OUT = arg("out", "/tmp/investigate");
const r = report("a failed row offers Investigate");

await withBrowser(async (h) => {
  const { page } = await h.session();
  await boot(page, pathUrl(PATH), { settleMs: 2500 });

  // Exact: a catalog row's own accessible name can CONTAIN the word
  // ("…reports nobody has investigated…").
  const button = page
    .getByRole("button", { name: "Investigate", exact: true })
    .first();
  const found = (await button.count()) > 0;
  r.ok("a failed row carries an Investigate button", found);
  if (!found) return;

  // The action is hover-revealed: hover its row first, as a person would.
  const row = page.locator("[data-row-key]", { has: button }).first();
  await row.hover();
  await snap(page, OUT, "hover");
  // Pending (the subject's task read not answered yet) is a disabled trigger.
  await page
    .waitForFunction(
      () => {
        const b = [...document.querySelectorAll("button")].find(
          (el) => el.getAttribute("aria-label") === "Investigate",
        );
        return b !== undefined && !(b as HTMLButtonElement).disabled;
      },
      undefined,
      { timeout: 10000 },
    )
    .catch((err: unknown) => {
      r.ok("the Investigate trigger becomes enabled", false, String(err));
      throw err;
    });
  await button.click();

  const title = page.getByText(/Investigate this failed/).first();
  await title.waitFor({ timeout: 5000 });
  r.ok(
    "the launch popover opens, titled for the failure",
    await title.isVisible(),
  );
  await snap(page, OUT, "popover");
});
