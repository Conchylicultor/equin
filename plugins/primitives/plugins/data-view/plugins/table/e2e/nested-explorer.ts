/**
 * Verifies the table view NESTING its rows over a hierarchical source — the
 * Studio explorer's "Table" view, the first live consumer (its source passes a
 * `hierarchy`; the view is the plain `table` type, not `tree`).
 *
 * What it proves, on the deployed app:
 *
 * - the table is a `treegrid` whose rows carry `aria-level`, collapsed by
 *   default (the explorer's table sets no `defaultExpanded`);
 * - a row's chevron opens exactly one level (its children appear right below
 *   it, one level deeper) and closes it again;
 * - a header click sorts WITHIN siblings — the open row's children come back
 *   in name order, still under their parent — and a second click reverses them;
 * - the search keeps a deep match's whole ancestor chain, forced open.
 *
 * The harness reverts the sort the header clicks write to the view's config.
 *
 * Manual only. Run after `./singularity build`:
 *   ./singularity run plugins/primitives/plugins/data-view/plugins/table/e2e/nested-explorer.ts \
 *     [--color-scheme light|dark] [--out /tmp/nested-explorer] [--headed]
 */
import type { Page } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/nested-explorer";
const SCHEME = arg("color-scheme") === "dark" ? "dark" : "light";

interface Line {
  id: string;
  level: number;
  expanded: string | null;
  label: string;
}

/** Every nested-table row currently painted, in paint order. */
const lines = (page: Page): Promise<Line[]> =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "[role='treegrid'] [data-tree-row]",
      ),
    ].map((el) => ({
      id: el.dataset.treeId ?? "",
      level: Number(el.getAttribute("aria-level")),
      expanded: el.getAttribute("aria-expanded"),
      label: (el.querySelector("[role='gridcell']")?.textContent ?? "").trim(),
    })),
  );

/** The lines directly under `lines[i]`: the run one level deeper right after it. */
function childrenOf(all: Line[], i: number): Line[] {
  const out: Line[] = [];
  for (let j = i + 1; j < all.length && all[j]!.level > all[i]!.level; j++) {
    if (all[j]!.level === all[i]!.level + 1) out.push(all[j]!);
  }
  return out;
}

const row = (page: Page, id: string) =>
  page.locator(`[role='treegrid'] [data-tree-id='${id}']`);

await withBrowser(async (h) => {
  const r = report("data-view table — nested rows (Studio explorer)");
  const { page, captured } = await h.session({
    colorScheme: SCHEME,
    viewport: { width: 1280, height: 900 },
  });

  await boot(page, pathUrl("/studio/explorer"), {
    marker: "[data-view-type='table']",
    settleMs: 800,
  });
  // The explorer's "Table" view (its "Tree" view is an outline table too, so
  // the chip is picked by name, not type).
  await page
    .locator("[data-view-type='table']", { hasText: "Table" })
    .first()
    .click();
  await page
    .locator("[role='treegrid'] [data-tree-row]")
    .first()
    .waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  await snap(page, OUT, `${SCHEME}-collapsed`);

  const roots = await lines(page);
  r.ok("the table painted nested rows", roots.length > 0);
  r.ok(
    "every row starts at level 1, collapsed (no defaultExpanded)",
    roots.every((l) => l.level === 1),
    JSON.stringify(roots.map((l) => l.level)),
  );
  const parentIndex = roots.findIndex((l) => l.expanded === "false");
  r.ok("some root has children to open", parentIndex >= 0);
  if (parentIndex < 0) await r.finish();
  const parent = roots[parentIndex]!;
  r.note(`opening "${parent.label}" (${parent.id})`);

  // --- The chevron opens one level -------------------------------------------
  await row(page, parent.id).hover();
  await row(page, parent.id)
    .getByRole("button", { name: "Expand", exact: true })
    .click();
  await page.waitForTimeout(400);
  const opened = await lines(page);
  const at = opened.findIndex((l) => l.id === parent.id);
  const kids = childrenOf(opened, at);
  r.eq("the row now reads expanded", opened[at]!.expanded, "true");
  r.ok(
    "its children appear right below it, one level deeper",
    kids.length > 0 && opened[at + 1]!.level === 2,
    JSON.stringify(opened.slice(at, at + 4)),
  );
  r.ok(
    "nothing deeper opened (one level, not the subtree)",
    opened.every((l) => l.level <= 2),
  );
  await snap(page, OUT, `${SCHEME}-expanded`);

  // --- A header sort orders the siblings, under their parent ------------------
  const header = page
    .locator("[role='treegrid'] > :first-child")
    .getByText("Name", { exact: true });
  await header.click();
  await page.waitForTimeout(500);
  const asc = await lines(page);
  const ascAt = asc.findIndex((l) => l.id === parent.id);
  const ascKids = childrenOf(asc, ascAt).map((l) => l.label);
  const sorted = [...ascKids].sort((a, b) => a.localeCompare(b));
  r.eq("ascending: the children in name order", ascKids, sorted);
  r.eq(
    "and still the same set, under the same parent",
    [...ascKids].sort(),
    kids.map((l) => l.label).sort(),
  );
  const ascRoots = asc.filter((l) => l.level === 1).map((l) => l.label);
  r.eq(
    "the roots are sorted too",
    ascRoots,
    [...ascRoots].sort((a, b) => a.localeCompare(b)),
  );
  await snap(page, OUT, `${SCHEME}-sorted`);

  await header.click();
  await page.waitForTimeout(500);
  const desc = await lines(page);
  const descKids = childrenOf(
    desc,
    desc.findIndex((l) => l.id === parent.id),
  ).map((l) => l.label);
  r.eq("descending reverses the siblings", descKids, [...sorted].reverse());
  // Third click drops the sort (back to the manual order).
  await header.click();
  await page.waitForTimeout(500);

  // --- The chevron closes it again ---------------------------------------------
  await row(page, parent.id).hover();
  await row(page, parent.id)
    .getByRole("button", { name: "Collapse", exact: true })
    .click();
  await page.waitForTimeout(400);
  const closed = await lines(page);
  r.eq("collapsing hides the children again", closed.length, roots.length);

  // --- Search keeps a deep match's ancestors ------------------------------------
  // `worktree-db` lives at database / db-test-fixture / worktree-db.
  const search = page.getByPlaceholder("Search…").first();
  await search.fill("worktree-db");
  await page.waitForTimeout(600);
  const found = await lines(page);
  const hit = found.findIndex((l) => l.label === "worktree-db");
  r.ok("the deep match is drawn", hit >= 0, JSON.stringify(found));
  if (hit >= 0) {
    const chain: Line[] = [];
    let level = found[hit]!.level;
    for (let j = hit - 1; j >= 0 && level > 1; j--) {
      if (found[j]!.level === level - 1) {
        chain.unshift(found[j]!);
        level--;
      }
    }
    r.ok(
      "every ancestor of the match is drawn above it, forced open",
      found[hit]!.level >= 2 &&
        chain.length === found[hit]!.level - 1 &&
        chain.every((l) => l.expanded === "true"),
      JSON.stringify(chain),
    );
    r.note(
      `chain: ${[...chain, found[hit]!].map((l) => `${l.label}@${l.level}`).join(" / ")}`,
    );
  }
  await snap(page, OUT, `${SCHEME}-search`);
  await search.fill("");

  const errors = [
    ...captured.pageErrors,
    ...captured.consoleErrors.filter((e) => !/Failed to load resource/.test(e)),
  ];
  r.ok("no page or console errors", errors.length === 0, errors.join("\n"));
  await r.finish();
});
