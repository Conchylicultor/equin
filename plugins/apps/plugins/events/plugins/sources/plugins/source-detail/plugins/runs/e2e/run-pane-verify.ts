/**
 * Drives the run ledger's one affordance: click a run row and land on the run's
 * own pane, carrying its contributed regions.
 *
 * The row itself is the target. It used to be a hover-revealed "Open run" action
 * pinned over the row, and this script used to assert the hit test at the
 * action's centre — the row body is a button and won that stack, so the action
 * was unreachable by pointer. Activating the row removes the stack rather than
 * arbitrating it, which is why the hit test is gone from here too: there is now
 * one target and it is the whole row.
 *
 * Manual only, like every script under `e2e/`. Needs a deployed worktree and a
 * source that has run at least once:
 *
 *   ./equin run plugins/apps/plugins/events/plugins/sources/plugins/source-detail/plugins/runs/e2e/run-pane-verify.ts --source <sourceId>
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const SOURCE_ID = arg("source");
const OUT = arg("out") ?? "/tmp/run-pane";

const r = report("Events · Run pane");

/**
 * The runs SECTION's own list. Scoped by the contributing plugin's lineage
 * attribute, not by "the first ListView on the page" — the sources list in the
 * column to the left is also one, and a bare page-wide match clicks THAT row and
 * reports a navigation that never happened.
 */
const RUNS_SECTION =
  '[data-plugin-id="apps.events.sources.source-detail.runs"]';
const ROW_MARKER = `${RUNS_SECTION} [data-ui-owner^="ListView@"]`;

await withBrowser(async (h) => {
  if (!SOURCE_ID) {
    r.fail("--source <sourceId> is required (a source with at least one run)");
    await r.finish();
  }

  const { page } = await h.session({ viewport: { width: 1600, height: 900 } });
  await boot(page, pathUrl(`/events/sources/source/${SOURCE_ID}`), {
    marker: ROW_MARKER,
    settleMs: 2500,
  });

  const row = page.locator(`${ROW_MARKER} button`).first();
  await row.waitFor({ state: "visible", timeout: 10_000 });
  r.ok("the run ledger painted at least one row", true);

  await row.click();
  await page.waitForTimeout(2000);

  const navigated = /\/run\/[0-9a-f-]{36}/.test(page.url());
  r.ok("clicking the run row opens the run pane", navigated, page.url());

  // Scoped to the run pane's own region hosts, and gated on `navigated`. A bare
  // page-wide getByText("Model call") passes on the UNNAVIGATED page as soon as
  // any source is named something like "model call" — a green line proving
  // nothing, which is the failure mode this harness exists to prevent.
  r.ok(
    "the run pane carries the contributed Model call region",
    navigated &&
      (await page
        .getByRole("button", { name: /Model call/ })
        .first()
        .isVisible()),
  );

  r.ok(
    "the run pane carries the contributed Extracted events region",
    navigated &&
      (await page
        .getByRole("button", { name: /Extracted events/ })
        .first()
        .isVisible()),
  );

  await snap(page, OUT, "run-pane");
  await r.finish();
});
