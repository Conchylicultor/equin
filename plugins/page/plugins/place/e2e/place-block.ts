// Drives the `/place` block as far as a worktree can reach: the slash menu
// offers it, converting a block mints a place block, and the empty state says
// something true about whether a lookup is possible.
//
// It deliberately stops before searching. A search needs a Google Maps API key,
// and the key lives on the CENTRAL runtime, which always runs main's code
// (`cli/plugins/build/cli/run.ts`: "agent worktrees never change central's running
// code"). So on a branch the provider is not registered centrally, and the
// honest end of this script is the "not set up" affordance — not a result list.
//
// A transcript tool, not a gate: it logs what it saw and fails only when the
// block cannot be created at all — and when the conversion posts a row write the
// server rejects, which is the one thing the transcript reported for months
// (`Invalid data for block type "place": … 'text'`) without anyone reading it as
// a failure. See `research/2026-08-19-page-row-text-invariant-at-the-write-funnel.md`;
// `page/editor/e2e/convert-in-place-verify.ts` is the real gate for that rule.
//
// Usage:
//   ./equin run plugins/page/plugins/place/e2e/place-block.ts [--url http://<worktree>.localhost:9000] [--headed]

import {
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openBlankPage } from "@plugins/page/plugins/editor/e2e";
import { PLACE_TYPE } from "@plugins/page/plugins/place/core";

const OUT = "/tmp/place-block";

await withBrowser(async (h) => {
  const { page, captured } = await h.session({ colorScheme: "dark" });

  const doc = await openBlankPage(page, { settleMs: 500 });
  console.log(`[1] blank page ${doc.pageUrl}`);

  // 1) The slash menu offers the block. `/plac` rather than `/place` so the
  //    match is exercised as a filter, the way a user types it.
  await doc.block.pressSequentially("/plac", { delay: 40 });
  await page.waitForTimeout(600);

  // Matched by TEXT, not by role: a block-menu row is a plain `<div>` — the
  // caret menu deliberately avoids a focusable control so the caret stays in
  // the contenteditable behind it — so there is no `option` or `button` role to
  // ask for. Scoped to the popover so the word cannot be satisfied by page
  // chrome, and `.last()` takes the innermost of the nested matches.
  const option = page
    .locator('[class*="bg-popover"]')
    .getByText("Place", { exact: true })
    .last();
  const offered = await option.isVisible();
  console.log(`[2] slash menu offers Place: ${offered}`);
  await snap(page, OUT, "2-slash-menu");
  if (!offered) {
    throw new Error(
      "the block menu did not offer Place — check the Media group in config/page/editor/page.editor.block.jsonc",
    );
  }

  // 2) Choosing it converts the block in place, keeping its id.
  await option.click();
  await page.waitForTimeout(900);

  // A block row carries only `data-block-id` (there is no `data-block-type`), so
  // "it converted" is read as "the row kept its id and no longer has a text
  // surface" — a place block is void.
  const row = page.locator(`[data-block-id="${doc.blockId}"]`);
  const editables = await row.locator('[contenteditable="true"]').count();
  console.log(
    `[3] block ${doc.blockId} kept its id and has ${editables} text surface(s) — a ${PLACE_TYPE} block should have 0`,
  );
  // The conversion's OTHER write: the `doc \u2192 data.text` projection flushes from
  // the text editor's unmount, which is exactly what converting to a void type
  // causes. Filtered to the signature rather than "any console error" \u2014 an
  // unrelated reconnect must not fail this.
  const rejected = captured.consoleErrors.filter((line) =>
    /blocks\/patch|Invalid data for block type|Unrecognized key/.test(line),
  );
  if (rejected.length > 0) {
    throw new Error(
      `converting to ${PLACE_TYPE} posted a row write the server rejected: ${JSON.stringify(rejected)}`,
    );
  }

  if ((await row.count()) === 0 || editables > 0) {
    throw new Error(
      `block ${doc.blockId} did not convert to a void ${PLACE_TYPE} block`,
    );
  }

  // 3) The empty state must SAY something. Either a search box (a provider is
  //    usable) or the provider's own set-up affordance — never a blank card,
  //    which is what a conflated loading/absent state renders.
  const searchBox = page.getByLabel("Search for a place");
  const setup = page.getByRole("button", { name: /set up google maps/i });
  const hasSearch = await searchBox.isVisible();
  const hasSetup = await setup.isVisible();
  console.log(
    `[4] empty state — search box: ${hasSearch}, set-up action: ${hasSetup}`,
  );
  await snap(page, OUT, "4-empty-state");

  if (!hasSearch && !hasSetup) {
    throw new Error(
      "the place block's empty state offered neither a search box nor a set-up action — it is rendering nothing, which is the failure mode the loading/absent split exists to prevent",
    );
  }

  // A freshly created place block is asking which place: the next keystroke
  // belongs in its search box, not on the block.
  if (hasSearch) {
    const focused = await searchBox.evaluate(
      (el) => el === document.activeElement,
    );
    console.log(`[4b] search box focused after creation: ${focused}`);
    if (!focused) {
      throw new Error("the new place block did not focus its search box");
    }
  }

  // 4) The conversion must SURVIVE a reload. This is the step worth having:
  //    the optimistic overlay renders a converted block whether or not the row
  //    write landed, so "it looks right" proves nothing until the page is read
  //    back from the server.
  //
  //    Wait on the first block becoming visible rather than on a fixed timeout —
  //    a cold page paints skeleton rows for seconds, and a timeout short enough
  //    to be pleasant reads those as "the block is gone".
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator("[data-block-id]")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1000);

  const survived = await page
    .locator(`[data-block-id="${doc.blockId}"]`)
    .isVisible();
  const setupAfter = await setup.isVisible();
  console.log(
    `[5] after reload — block ${doc.blockId} present: ${survived}, set-up action: ${setupAfter}`,
  );
  await snap(page, OUT, "5-after-reload");
  if (!survived) {
    throw new Error(
      `block ${doc.blockId} did not survive a reload — the conversion was never persisted`,
    );
  }

  console.log(
    "[ok] place block reachable from the slash menu, persisted, and self-explaining when unset",
  );
});
