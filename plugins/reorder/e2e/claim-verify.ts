// Pins the reorder CLAIM invariant on the real deployed app:
//
//   A contribution is a sortable item iff it was rendered as an ITEM OF an area
//   — by that area's own `renderItem` — not merely somewhere underneath it.
//
// The leak this catches is a slot dispatched from INSIDE a contribution
// (`.Dispatch` / `renderIsolated` mount no area of their own): it used to
// inherit the ambient `ReorderAreaContext` and register `useSortable` with a
// per-CONTRIBUTION id, so N rendered instances of one contribution meant N
// duplicate dnd-kit ids in a single `DndContext`.
//
// The surface is a CALLER ARGUMENT, not a list baked in here. This is a reorder
// harness, so it must not carry one app's route: the case it used to hardcode
// (the website's editor-toy demo, whose block editor dispatched `Editor.Block`
// under a section contribution) was deleted with that demo, and a hardcoded
// route is exactly what let it rot unnoticed. Point it at any surface where a
// slot is dispatched from inside a contribution:
//
//   --url     the page to open (path or absolute URL)
//   --nested  a CSS selector for the content that slot dispatch renders; it is
//             what must contain no sortable of its own
//
// Edit mode MUST be on: an area's drag host (the `DeferredSortableList`
// registrations that hand each item its dnd-kit attributes) is mounted only in
// edit mode — so the `aria-roledescription="sortable"` marker is
// absent everywhere outside edit mode and the probe would read 0 both before and
// after the fix, proving nothing. The `total > 0` guard below asserts that edit
// mode really engaged, so `inside === 0` means something.
//
// The same invariant is pinned in-process, with no surface to go stale, by
// `plugins/reorder/web/__tests__/item-claim.test.tsx`.
//
// Usage:
//   ./singularity run plugins/reorder/e2e/claim-verify.ts \
//     --path /some/route --nested '[data-block-id]' \
//     [--url http://<worktree>.localhost:9000] [--headed]
//
// The surface is `--path` (or a full `--url` carrying it); `--url` alone names
// which deploy to open it on.

import {
  report,
  requireArg,
  requirePage,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { setEditMode } from "@plugins/reorder/plugins/edit-mode/e2e";

const SORTABLE = '[aria-roledescription="sortable"]';

const USAGE =
  "usage: claim-verify.ts --path <route> --nested <css-selector> [--url <deploy>] [--headed]";

/** A surface where a slot is dispatched from inside a reorderable contribution. */
const url = requirePage(USAGE);
/** The nested content that must contain NO sortable of its own. */
const nested = requireArg("nested", USAGE);

const name = `${new URL(url).pathname} → ${nested}`;

const r = report("reorder claim");

await withBrowser(async (h) => {
  const { page } = await h.session();

  await page.goto(url);
  await page.waitForTimeout(3000);

  await setEditMode(page, true);
  await page.waitForTimeout(800);

  const total = await page.locator(SORTABLE).count();
  const inside = await page.locator(`${nested} ${SORTABLE}`).count();
  r.note(`${name}: sortables on page=${total}, inside nested=${inside}`);

  // Non-vacuity guards FIRST: they prove edit mode really engaged and that the
  // nested content is even on this page, so the `inside === 0` assertion below
  // means something.
  r.ok(
    `${name}: edit mode engaged`,
    total > 0,
    `no sortables anywhere (got ${total})`,
  );
  const nestedCount = await page.locator(nested).count();
  r.ok(
    `${name}: nested content is present`,
    nestedCount > 0,
    `--nested '${nested}' matched nothing — probe vacuous`,
  );
  r.eq(`${name}: no sortable inside nested content`, inside, 0);

  await setEditMode(page, false);
  await page.waitForTimeout(400);
});

await r.finish();
