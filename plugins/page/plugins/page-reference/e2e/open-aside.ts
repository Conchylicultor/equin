/**
 * Verifies the hover-revealed "Open in side pane" action on a page reference,
 * end to end: the button is HIDDEN at rest, appears when the row is hovered, and
 * opening it leaves the page you were reading on screen — a second column, not a
 * replacement.
 *
 * A blind screenshot cannot check any of that. The cluster is `opacity-0
 * pointer-events-none` until its row is hovered (so a click at rest lands on the
 * row and navigates in place, which is the OTHER intent), and "beside, not
 * instead" is a statement about the route growing rather than swapping.
 *
 *   ./equin run plugins/page/plugins/page-reference/e2e/open-aside.ts --headed
 *   ./equin run plugins/page/plugins/page-reference/e2e/open-aside.ts --page block-<uuid>
 */
import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/page-open-aside";
/** A page known to contain a sub-page row; otherwise one is hunted for below. */
const PAGE = arg("page");
/** How many sidebar pages to open while hunting for one with a sub-page row. */
const HUNT_LIMIT = 10;

const ACTION = "Open in side pane";
/** Two page-detail columns in the route: `…/page/<a>/page/<b>`. */
const TWO_PAGES = /\/page\/[^/]+\/page\/[^/]+/;

await withBrowser(async (h) => {
  const r = report("page reference — open in side pane");
  const { page } = await h.session();

  /** Every sub-page row currently painted in the page body. */
  const subPageRows = () => page.locator('[data-ui-owner^="SubPageBlock"]');

  /**
   * Did `locator` appear within `ms`? A discriminated answer, not an absorbed
   * one: only Playwright's own TimeoutError means "it did not appear", and
   * anything else (a detached frame, a bad selector) still throws.
   */
  const appears = async (
    locator: ReturnType<typeof subPageRows>,
    ms: number,
  ): Promise<boolean> => {
    try {
      await locator.waitFor({ state: "visible", timeout: ms });
      return true;
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") return false;
      throw err;
    }
  };

  if (PAGE) {
    await page.goto(pathUrl(`pages/page/${PAGE}`), {
      waitUntil: "domcontentloaded",
    });
    await subPageRows().first().waitFor({ state: "visible", timeout: 30_000 });
  } else {
    // No page named: open sidebar pages until one shows a sub-page reference.
    await page.goto(pathUrl("pages"), { waitUntil: "domcontentloaded" });
    const rows = page.locator('[data-ui-owner^="TreeRowChrome"]');
    await rows.first().waitFor({ state: "visible", timeout: 30_000 });
    const total = Math.min(await rows.count(), HUNT_LIMIT);
    let found = false;
    for (let i = 0; i < total && !found; i++) {
      await rows.nth(i).click();
      found = await appears(subPageRows().first(), 2_000);
    }
    r.ok(
      `a page with a sub-page reference was found (searched ${total})`,
      found,
      "pass --page <blockId> to name one directly",
    );
    if (!found) await r.finish();
  }

  const row = subPageRows().first();
  const button = row.getByRole("button", { name: ACTION, exact: true });
  await snap(page, OUT, "before");

  /**
   * The cluster's PAINTED state, read off computed style rather than asked of
   * Playwright: `isVisible()` answers about layout, and an `opacity-0
   * pointer-events-none` cluster is laid out — it would report visible at rest
   * and the assertion would prove nothing. Both halves are read because they are
   * the coupling under test: a faded cluster that still took clicks would be an
   * invisible click-target over the row's right edge.
   *
   * Through `page.evaluate` and a plain query, NOT `locator.evaluate`: the
   * latter runs Playwright's actionability wait first, which never settles on a
   * live page whose toasts keep re-laying out — and this reads a style, it does
   * not act on the element, so it has nothing to wait for.
   */
  const painted = () =>
    page.evaluate((name: string) => {
      const el = document.querySelector(`button[aria-label="${name}"]`);
      if (el === null)
        return { mounted: false, visible: false, clickable: false };
      return {
        mounted: true,
        // `checkVisibility({opacityProperty})` and not the button's own computed
        // opacity: the fade rides the CLUSTER, and `opacity` does not inherit —
        // the button reads 1 while sitting invisible inside a faded box.
        visible: el.checkVisibility({ opacityProperty: true }),
        clickable: getComputedStyle(el).pointerEvents !== "none",
      };
    }, ACTION);

  // At rest the action is mounted — it stays in the tab order — but neither
  // painted nor clickable.
  r.eq("the action is mounted at rest", await button.count(), 1);
  r.eq("the action is unpainted and inert at rest", await painted(), {
    mounted: true,
    visible: false,
    clickable: false,
  });

  await row.hover();
  await page.waitForFunction(
    (name: string) => {
      const el = document.querySelector(`button[aria-label="${name}"]`);
      return el !== null && el.checkVisibility({ opacityProperty: true });
    },
    ACTION,
    { timeout: 5_000 },
  );
  r.eq("hovering the reference reveals the action", await painted(), {
    mounted: true,
    visible: true,
    clickable: true,
  });
  await snap(page, OUT, "hovered");

  const before = page.url();
  r.ok("one page column before the action", !TWO_PAGES.test(before), before);

  await button.click();
  // Deliberately unguarded: if the route never grows, the feature is broken and
  // the script must die saying so rather than report a tidy failed assertion.
  await page.waitForFunction(
    (re: string) => new RegExp(re).test(window.location.pathname),
    TWO_PAGES.source,
    { timeout: 10_000 },
  );
  await snap(page, OUT, "after");

  const after = page.url();
  r.note(`route: ${before} → ${after}`);
  r.ok(
    "the referenced page opened BESIDE the one being read",
    TWO_PAGES.test(after),
    after,
  );
  // The page that was being read is still the leftmost column, so its own
  // sub-page row — the one just clicked — is still on screen.
  r.ok("the original page is still rendered", await row.isVisible());

  await r.finish();
});
