/**
 * Verifies the nested table's **per-group fold** — the unfold/fold button a
 * grouped hierarchical table hangs off each group header, beside the count
 * (the tree primitive's `groupFoldAction`, handed to `DataViewGroupHeader`'s
 * `action`).
 *
 * Separate from the tree primitive's own `subtree-fold.ts` because the two
 * buttons sit in different places: the per-row fold is every tree row's
 * chrome, while this one exists only when a nesting table is grouped. The
 * reference surface is the tasks list (`--at`, default `/agents/tasks`),
 * grouped by category.
 *
 * ## The guard that makes this worth a script
 *
 * The group header is ITSELF the group's collapse trigger. So a fold button
 * sitting on it is one stray click away from collapsing the very group it was
 * asked to fold — the design rests on `RowActions`' button `Stack` stopping
 * `onClick` and `onPointerDown`. Nothing types that guarantee, so the
 * assertion that the group is still OPEN after the fold is the only thing
 * holding it.
 *
 * The header's cluster is hover-revealed like a row's, so every interaction goes
 * header → `hover()` → button. Playwright calls an `opacity-0` element
 * "visible", so the reveal is asserted from computed opacity + pointer-events.
 *
 * Manual only. Run after `./singularity build`:
 *   ./singularity run plugins/primitives/plugins/data-view/plugins/table/e2e/group-fold.ts \
 *     [--at /agents/tasks] [--headed]
 */
import type { Locator, Page } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/group-fold";
const AT = arg("at") ?? "/agents/tasks";

const EXPAND = "Expand group";
const COLLAPSE = "Collapse group";

interface Reveal {
  opacity: number;
  pointerEvents: string;
}

/**
 * Both halves of "can this actually be clicked": the fade lives on the cluster
 * rather than the button, and `pointer-events: none` is what keeps a hidden
 * control from being a click target. Read up the ancestor chain, stopping at
 * the header row that owns the `group/row-actions` reveal.
 */
const reveal = (button: Locator): Promise<Reveal> =>
  button.evaluate((el) => {
    let opacity = 1;
    let pointerEvents = "auto";
    for (
      let n: HTMLElement | null = el as HTMLElement;
      n;
      n = n.parentElement
    ) {
      const style = getComputedStyle(n);
      opacity = Math.min(opacity, Number(style.opacity));
      if (style.pointerEvents === "none") pointerEvents = "none";
      if (String(n.className).includes("group/row-actions")) break;
    }
    return { opacity, pointerEvents };
  });

/**
 * The cluster's settled reveal state. The fade is a CSS transition, so a single
 * read right after a pointer move catches it mid-flight; this polls for the
 * steady state and reports what it last saw if that state never arrives, so a
 * real failure still prints a real number.
 */
async function settledReveal(button: Locator, want: 0 | 1): Promise<Reveal> {
  const deadline = Date.now() + 3_000;
  let last = await reveal(button);
  while (last.opacity !== want && Date.now() < deadline) {
    await button.page().waitForTimeout(100);
    last = await reveal(button);
  }
  return last;
}

const rowCount = (page: Page): Promise<number> =>
  page.locator(".group\\/tree-row").count();

await withBrowser(async (h) => {
  const r = report("data-view nested table — per-group fold");
  const { page, captured } = await h.session();

  const badResponses: string[] = [];
  page.on("response", (res) => {
    if (res.status() >= 400) {
      badResponses.push(`${res.status()} ${res.url()}`);
    }
  });

  await boot(page, pathUrl(AT), {
    marker: "[role='treegrid'] .group\\/tree-row",
    settleMs: 800,
  });
  await snap(page, OUT, "before");

  // The group header row: the `group/row-actions` node holding the group's
  // fold (its collapse trigger and its action cluster both live inside it).
  // The header's cluster is in flow (`pin={null}`), so it is mounted at rest.
  const header = page
    .locator("[role='treegrid'] .group\\/row-actions")
    .filter({
      has: page.getByRole("button", { name: /^(Expand|Collapse) group$/ }),
    })
    .first();
  await header.waitFor({ state: "visible", timeout: 30_000 });
  r.ok("the table is grouped (a group header with a fold is painted)", true);

  /** The section's own collapse trigger — the header's `aria-expanded` button. */
  const sectionTrigger = header.locator("button[aria-expanded]").first();
  const sectionOpen = async (): Promise<string | null> =>
    sectionTrigger.getAttribute("aria-expanded");
  r.eq("the section starts open", await sectionOpen(), "true");

  const fold = (name: string): Locator =>
    header.getByRole("button", { name, exact: true });

  const before = await rowCount(page);
  r.note(`rows before: ${before}`);
  r.eq("the fold starts on the expand spelling", await fold(EXPAND).count(), 1);

  // --- Hidden at rest, revealed on hover ------------------------------------
  await page.mouse.move(1200, 760);
  const atRest = await settledReveal(fold(EXPAND), 0);
  r.eq(
    "the group fold is invisible until the header is hovered",
    atRest.opacity,
    0,
  );
  r.eq("and is not a click target while hidden", atRest.pointerEvents, "none");

  await header.hover();
  const hovered = await settledReveal(fold(EXPAND), 1);
  r.eq("hovering the header reveals it", hovered.opacity, 1);
  r.eq("and makes it clickable", hovered.pointerEvents, "auto");

  // --- Unfold the group ------------------------------------------------------
  await fold(EXPAND).click();
  await page.waitForTimeout(500);
  await snap(page, OUT, "expanded");

  const opened = await rowCount(page);
  r.note(`rows after unfolding the group: ${opened}`);
  r.ok(
    "unfolding the group shows more rows",
    opened > before,
    `${before} → ${opened}`,
  );
  // The header is the section's own collapse trigger, so this is the assertion
  // that the nested cluster's stopPropagation genuinely works.
  r.eq("the section itself is still open", await sectionOpen(), "true");
  r.eq(
    "the fold flips to the collapse spelling",
    await fold(COLLAPSE).count(),
    1,
  );

  // --- Fold it back ----------------------------------------------------------
  await header.hover();
  await fold(COLLAPSE).click();
  await page.waitForTimeout(500);
  await snap(page, OUT, "after");

  const closed = await rowCount(page);
  r.eq("folding the group returns the rows it opened", closed, before);
  r.ok(
    "folding the group did not empty the section",
    closed > 0,
    "a collapsed SECTION would paint no rows at all",
  );
  r.eq(
    "the section is still open after folding too",
    await sectionOpen(),
    "true",
  );
  r.eq(
    "and the fold reads 'Expand group' again",
    await fold(EXPAND).count(),
    1,
  );

  r.ok(
    "no failing requests (the duress-shed log beacon excluded)",
    badResponses.length === 0,
    [...new Set(badResponses)].join("\n"),
  );
  const errors = [
    ...captured.pageErrors,
    // The console echo of a network response, already covered above.
    ...captured.consoleErrors.filter((e) => !/Failed to load resource/.test(e)),
  ];
  r.ok("no page or console errors", errors.length === 0, errors.join("\n"));
  await r.finish();
});
