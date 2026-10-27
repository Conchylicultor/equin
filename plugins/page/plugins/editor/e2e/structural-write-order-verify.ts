// Causally dependent structural writes reach the server IN ISSUE ORDER — read
// off the AUTHORITATIVE rows, in a real browser.
// See research/2026-08-01-page-structural-write-contract.md (invariant B).
//
// The defect: a `convertTo` (the `- ` markdown shortcut) and the `split` that
// inherits its type were independent POSTs, so the browser could deliver them in
// either order. Arriving reversed, the split committed against a paragraph and
// the user's bullet silently reverted ONE PUSH LATER — the client had predicted
// both ops correctly, so nothing on screen said anything was wrong until the
// authoritative snapshot landed.
//
// Latent for months because a human pauses between structural edits; the caret
// authority replays buffered keystrokes with NO pause, so it became routine.
// Every keystroke here is therefore issued with ZERO delay and no settle: the
// race is the test.
//
// **The assertion reads `GET /api/pages/:pageId/blocks`, not the DOM.** The DOM
// is the optimistic overlay, which is right by construction — it applied the two
// ops in issue order locally. Only server truth can disagree, and only server
// truth is what survives a reload.
//
// Usage: bun plugins/page/plugins/editor/e2e/structural-write-order-verify.ts [--url <deploy>]
import {
  pageFetch,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { editableBlocks, openBlankPage } from "./support/blank-page";

const r = report();

/** How many times the zero-delay burst is repeated. A reorder is a RACE. */
const ROUNDS = 6;
/** Time allowed for every write of a round to commit before rows are read. */
const COMMIT_MS = 3000;

interface Row {
  id: string;
  type: string;
  rank: string;
}

await withBrowser(async (h) => {
  const { page } = await h.session();

  /**
   * The page's rows as the SERVER holds them. Fetched through the page's own
   * browser context so it rides the app's session, and deliberately not through any
   * client cache — this is the whole point of the script.
   */
  const authoritativeRows = async (id: string): Promise<Row[]> => {
    const res = await pageFetch(page, `/api/pages/${id}/blocks`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`GET blocks -> ${res.status}`);
      const rows = (await res.json()) as {
        id: string;
        type: string;
        rank: string;
      }[];
      return rows.map((b) => ({
        id: b.id,
        type: b.type,
        rank: String(b.rank),
      }));
  };

  const { pageId } = await openBlankPage(page, { settleMs: 3000 });

  // Every round starts on an EMPTY `text` block, so `- ` really is a
  // line-leading marker and the shortcut really fires.
  for (let round = 1; round <= ROUNDS; round++) {
    // `- ` fires the block markdown shortcut on the SPACE keystroke: the block
    // converts to `bulleted-list` (a patch POST) and the marker is stripped from
    // the content doc. The `x` gives the bullet a body, so the Enter is a real
    // SPLIT (an op POST) and not the empty-Enter ladder — and the tail inherits
    // the origin's type, which IS the dependency. No settle anywhere: the two
    // POSTs leave milliseconds apart, which is the whole reorder window.
    await page.keyboard.type(`- x${round}`);
    await page.keyboard.press("Enter");

    await page.waitForTimeout(COMMIT_MS);

    const rows = await authoritativeRows(pageId);
    // Document order over one flat sibling list; every row here is top-level.
    const ordered = [...rows].sort((x, y) => (x.rank < y.rank ? -1 : 1));

    r.eq(
      `round ${round}: the split really produced a new row`,
      ordered.length,
      round + 1,
    );
    // THE assertion. Reordered, the split commits against a paragraph and the
    // tail is a `text` row — the bullet then "reverts" one push later.
    r.eq(
      `round ${round}: the tail inherited the bullet type on the SERVER`,
      ordered.at(-1)?.type,
      "bulleted-list",
    );
    r.eq(
      `round ${round}: ... and so did the block it split from`,
      ordered.at(-2)?.type,
      "bulleted-list",
    );

    // Reset: the tail is an EMPTY bullet, so Enter walks the empty-Enter ladder
    // and strips the type back to `text` — the next round's blank slate.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
  }

  // A reload proves it is the persisted state, not a still-pending overlay: an
  // op that never confirmed would keep rendering its prediction forever under
  // the never-revert policy, so the DOM alone can never settle this.
  await page.reload({ waitUntil: "domcontentloaded" });
  await editableBlocks(page)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(3000);

  const finalRows = await authoritativeRows(pageId);
  r.eq(
    "every round's split block is still a bullet after a reload",
    finalRows.filter((b) => b.type === "bulleted-list").length,
    ROUNDS,
  );

  await r.finish();
});
