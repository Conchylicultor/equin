// Round-trips a page's starred state through its live favorites set (an `all`
// collection): read the header star, toggle it, confirm the flip, toggle it
// back.
//
// The toggle is the whole point of the check. Starring is a membership ENTRY
// of the set and unstarring an EXIT, and those are the two paths that ship a
// delta rather than a whole-set reload — so a star that flips and holds is
// the evidence that the incremental membership path works end to end. The
// script always restores the page's original state, so it is safe to re-run.
//
// Usage:
//   ./singularity run plugins/apps/plugins/pages/plugins/starred/e2e/starred-verify.ts \
//     --page <pageId> [--settle 60000] [--headed]
//
// `--page` is required — pick any page:
//   select id from page_blocks where type = 'page' limit 1;

import {
  numArg,
  pathUrl,
  report,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const pageId = requireArg("page", "usage: --page <pageId> [--settle <ms>]");
const settleMs = numArg("settle", 60_000);

// Both labels, because the button IS its state: the star reads "Add to
// favorites" when hollow and "Remove from favorites" when filled.
const STAR =
  '[aria-label="Add to favorites"], [aria-label="Remove from favorites"]';
const url = pathUrl(`/pages/page/${pageId}`);

const r = report("pages-starred.all set resource");
console.log(`url: ${url}`);

const outcome = await withBrowser(async (h) => {
  const { page, captured } = await h.session();
  await page.goto(url);
  await page.waitForSelector(STAR, { timeout: settleMs });
  // The open page's OWN star, in the detail pane header — NOT the hover-revealed
  // star that every sidebar tree row also carries (same button, many instances,
  // and a row's is behind its label until hovered). In the Miller layout the
  // detail column follows the sidebar column in DOM order and every tree row
  // lives in the sidebar, so the header's star is the last match.
  const star = page.locator(STAR).last();

  // aria-pressed is the star's own answer about what it read from the set.
  const pressed = async (): Promise<string | null> =>
    await star.getAttribute("aria-pressed");

  // Let the post-mount round-trip land before sampling the baseline, or the
  // "before" is just the pending rendering.
  await page.waitForTimeout(3000);
  const before = await pressed();

  await star.click();
  const flipDeadline = Date.now() + settleMs;
  let after = before;
  while (Date.now() < flipDeadline) {
    after = await pressed();
    if (after !== before) break;
    await page.waitForTimeout(500);
  }

  // Restore, whatever happened above.
  if (after !== before) {
    await star.click();
    await page.waitForTimeout(2000);
  }
  const restored = await pressed();

  return {
    before,
    after,
    restored,
    pageErrors: captured.pageErrors,
    consoleErrors: captured.consoleErrors,
  };
});

r.note(
  `aria-pressed: before=${outcome.before} after=${outcome.after} restored=${outcome.restored}`,
);
r.ok(
  "star reflects the window",
  outcome.before === "true" || outcome.before === "false",
  `expected a settled aria-pressed, got ${outcome.before}`,
);
r.ok(
  "toggle flips it",
  outcome.after !== outcome.before,
  `stayed ${outcome.after}`,
);
r.eq("restored to original", outcome.restored, outcome.before);
r.ok(
  "no page errors",
  outcome.pageErrors.length === 0,
  outcome.pageErrors.join(" | "),
);
r.ok(
  "no console errors",
  outcome.consoleErrors.length === 0,
  outcome.consoleErrors.join(" | "),
);
await r.finish();
