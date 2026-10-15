/**
 * Pins the regression: the Pages sidebar tree must stay **drag-reorderable while
 * it shows only part of the roots**.
 *
 * The sidebar splits the page tree into sections — Private (`origin is user`)
 * and Scratch (`origin is agent`), each a root-scoped filter of its own view —
 * and before that into `groupBy: "origin"` groups. The tree used to drop
 * `hierarchy.onMove` whenever it saw only part of the roots (under a group-by)
 * — so reordering silently stopped working in the default view, with no
 * visible cause. The suspension existed because a partial tree could mint
 * a rank colliding with a hidden root; the drop contract now carries only an
 * anchor, which the server resolves against the complete sibling set
 * (`research/2026-07-30-global-anchor-only-rank-authority.md`).
 *
 * ## What this asserts, and why it is the affordance rather than a gesture
 *
 * The nested table wires a row's drag source **only** when `canReorder`
 * (`= !!onMove`, `useTreeModel`). So dnd-kit's draggable attributes
 * (`aria-roledescription="draggable"`, `aria-disabled="false"`) are present on a
 * grouped row **iff** `onMove` survived the gate — which is exactly the bug.
 * Under the old code they were absent, because the tree passed no handler.
 *
 * It deliberately does NOT synthesize a pointer drag. dnd-kit's `PointerSensor`
 * does not reliably activate under Playwright's synthetic pointer stream, so a
 * simulated drag here reports nothing about the product — an earlier version of
 * this file did exactly that and produced a false PASS while a loose
 * `getByText().first()` grabbed a page-link in the editor and let the *block*
 * editor's own DnD reparent a page. Rows are therefore located as tree rows
 * (`.group/tree-row` containing the exact label), never page-wide text.
 *
 * The rank round-trip the drop depends on is covered where it can be asserted
 * exactly — `rankAdjacentTo`'s unit tests
 * (`plugins/primitives/plugins/rank/server/internal/adjacent.test.ts`) and the
 * `POST /api/blocks/:id/move` contract itself.
 *
 * Manual only. Run after `./singularity build`:
 *   ./singularity run plugins/apps/plugins/pages/plugins/page-tree/e2e/grouped-reorder.ts [--headed]
 */
import type { Locator, Page } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

/** Two ROOT pages that live in the same section. */
const FIRST = arg("first") ?? "Website";
const SECOND = arg("second") ?? "Todos";

/** The tree row (not a page-link, not the detail header) labelled exactly `title`. */
const row = (page: Page, title: string): Locator =>
  page
    .locator(".group\\/tree-row")
    .filter({ has: page.getByText(title, { exact: true }) })
    .first();

/** dnd-kit stamps these onto a row only when its drag source is wired. */
async function dragAffordance(page: Page, title: string) {
  return row(page, title).evaluate((el) => ({
    draggable: el.getAttribute("aria-roledescription") === "draggable",
    disabled: el.getAttribute("aria-disabled"),
    indent: parseFloat(getComputedStyle(el).paddingLeft) || 0,
  }));
}

const r = report("pages sidebar grouped drag-reorder");

await withBrowser(async (h) => {
  const { page } = await h.session();

  await boot(page, pathUrl("/pages"), {
    marker: `text="${FIRST}"`,
    settleMs: 800,
  });
  await row(page, SECOND).waitFor({ state: "visible", timeout: 30_000 });

  // The surface really is sectioned — otherwise nothing below proves anything.
  // `isVisible()` already answers false for a missing locator, so a catch here
  // would only turn a real Playwright fault into a passing-looking absence.
  const grouped = await page
    .getByRole("button", { name: /^Private/ })
    .first()
    .isVisible();
  r.ok(
    "the sidebar renders the Private section header (sections are live)",
    grouped,
  );

  const a = await dragAffordance(page, FIRST);
  const b = await dragAffordance(page, SECOND);

  r.ok(
    `"${FIRST}" is a live drag source while grouped (onMove survived the gate)`,
    a.draggable && a.disabled === "false",
    JSON.stringify(a),
  );
  r.ok(
    `"${SECOND}" is a live drag source while grouped`,
    b.draggable && b.disabled === "false",
    JSON.stringify(b),
  );
  r.ok(
    `both rows sit at the same (root) depth: ${a.indent}px / ${b.indent}px`,
    a.indent === b.indent,
  );
});

await r.finish();
