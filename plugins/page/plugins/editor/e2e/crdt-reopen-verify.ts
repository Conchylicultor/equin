// Reopen-an-edited-block regression (per-block CRDT plan,
// research/2026-07-07-page-per-block-crdt-plan-b.md).
//
// The bug this pins down: `connect()`'s instant pre-seed (Stage 4a) fired for
// EVERY first connect — including an existing, previously-edited block on a
// cold page load — because the "row confirmed" / "server state" signals arrive
// from PARENT effects that run after the child CollaborationPlugin's connect.
// The pre-seed (hashed from the CURRENT projected `data.text`) then merged
// with the stored doc (original seed + live-edit items under other clientIDs):
// two independent CRDT encodings of the same visible text → the paragraph
// rendered TWICE, and the projection persisted the doubled runs, compounding
// on every reopen.
//
// Scenario:
//  1. create a blank page, type a distinctive string into its text block;
//  2. wait for the doc flush AND the `data.text` projection to land;
//  3. COLD-reopen the page (a fresh browser context — a same-context reload
//     restores the persisted tab set onto the Pages landing instead of the
//     deep link, so a new context is the real "reopen" path); assert the
//     block shows the text EXACTLY ONCE — in the DOM, in `data.text`, and in
//     the decoded `page_block_docs` state;
//  4. reopen again to prove it does not compound.
//
// NOTE on reproducibility: with the CURRENT @lexical/react (0.44),
// CollaborationPlugin happens to defer provider.connect() by two internal
// commits, so the owning hook's markBlockRowConfirmed effect wins the race
// and this e2e passes even before the construction-time-discriminator fix —
// the connect-before-latch interleave is only reachable at the provider
// contract level. The failing-then-fixed reproducer for that mechanism is
// plugins/page/plugins/editor/web/__tests__/live-state-yjs-provider.test.ts;
// this e2e pins the end-to-end invariant against regressions in either layer.
//
// Usage: bun plugins/page/plugins/editor/e2e/crdt-reopen-verify.ts [--url <deploy>] [--out /tmp/crdt-reopen]
import {
  agentFetch,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  ELEMENT_TIMEOUT_MS,
  waitFor,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";
// This script lives inside the editor plugin, which declares `yjs` as a
// dependency — so the bare specifier resolves by ordinary walk-up. (Before the
// per-plugin move this was a `createRequire` against a hardcoded
// `../plugins/page/plugins/editor/package.json` URL, which only worked because
// the old flat `e2e/` folder happened to sit beside `plugins/`.)
import * as Y from "yjs";
import { blockText, openBlankPage } from "./support/blank-page";

const out = arg("out", "/tmp/crdt-reopen");

const TYPED = "quantum flamingo orchestra rehearsal";

/** Count non-overlapping occurrences of `needle` in `hay`. */
function countOccurrences(hay: string, needle: string): number {
  let count = 0;
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at < 0) return count;
    count += 1;
    i = at + needle.length;
  }
}

interface BlockRow {
  id: string;
  data?: { text?: { text: string }[] };
}

async function fetchBlockText(
  pageId: string,
  blockId: string,
): Promise<string> {
  const rows = (await (
    await agentFetch(`/api/pages/${pageId}/blocks`)
  ).json()) as BlockRow[];
  const row = rows.find((r) => r.id === blockId);
  const runs = row?.data?.text ?? [];
  return runs.map((run) => run.text).join("");
}

/**
 * Decode the stored page_block_docs state to its plain text (via doc-init echo).
 *
 * Deliberately NOT `blockDocText` from `@plugins/page/plugins/editor-collab/e2e`:
 * that reads through the live-state resource endpoint and concatenates the
 * paragraph deltas, whereas this test reads through the doc-init echo (a read
 * path it is also implicitly exercising) and asserts on the XmlText
 * serialization, so a duplicated paragraph shows up as markup too.
 */
async function fetchDocText(blockId: string): Promise<string> {
  // doc-init with an EMPTY update is a read: the row exists (we flushed), so
  // ON CONFLICT DO NOTHING no-ops and the response is the stored state.
  // Copy into an ArrayBuffer-backed view: yjs types its output as
  // Uint8Array<ArrayBufferLike>, which BodyInit rejects (it could be shared).
  const emptyUpdate = new Uint8Array(Y.encodeStateAsUpdate(new Y.Doc()));
  const res = await agentFetch(`/api/blocks/${blockId}/doc-init`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: emptyUpdate,
  });
  if (!res.ok) throw new Error(`doc-init read failed: ${res.status}`);
  const { state } = (await res.json()) as { state: string };
  const bytes = Uint8Array.from(atob(state), (c) => c.charCodeAt(0));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  // @lexical/yjs stores content as one XmlText under the fixed key "root";
  // toString() serializes embedded paragraphs — plain text appears verbatim.
  return doc.get("root", Y.XmlText).toString();
}

const r = report();

await withBrowser(async (h) => {
  const { context: ctx, page } = await h.session();

  const { pageUrl, pageId, block, blockId } = await openBlankPage(page, {
    settleMs: 3000,
  });
  console.log("page url:", pageUrl);
  console.log("block id:", blockId);
  await block.click();
  await page.keyboard.type(TYPED, { delay: 12 });

  // Wait for the doc-update flush (300ms debounce) AND the data.text projection
  // (1s debounce) to land server-side before reloading.
  // This loop WAS the repo's bounded-retry precedent, and `waitFor` is it
  // generalized: same semantics (bounded, re-read, keep the last value for the
  // failure message), minus the guaranteed 500ms before the first read, plus the
  // waited/attempts numbers that make a slow pass distinguishable from a fast
  // one. See the harness's wait.ts for why that distinction is load-bearing.
  const projection = await waitFor(
    () => fetchBlockText(pageId, blockId),
    (text) => text === TYPED,
  );
  console.log(
    `projection settled after ${projection.waitedMs}ms (${projection.attempts} reads)`,
  );
  r.ok(
    "projection wrote data.text before reload",
    projection.ok,
    JSON.stringify(projection.value),
  );
  await snap(page, out, "before-reload");

  // Close the writer context so the reopen is genuinely cold (no shared
  // leader-elected socket, no in-memory doc registry).
  await ctx.close();

  /** Cold-open the page in a fresh context and run the exactly-once checks. */
  async function reopenAndVerify(round: number): Promise<void> {
    const { context: freshCtx, page: freshPage } = await h.session({
      label: `reopen ${round}`,
    });
    await freshPage.goto(pageUrl);
    const blockAfter = freshPage
      .locator(`[data-block-id="${blockId}"] [data-block-text]`)
      .first();
    await blockAfter.waitFor({
      state: "visible",
      timeout: ELEMENT_TIMEOUT_MS,
    });
    // Was a fixed `waitForTimeout(3000)`. A second context measured 6.2-9.7s to
    // render text against main, so this read could land before the text arrived
    // and report a duplication defect as an empty string. Waiting on the
    // condition instead — and the assertion is still EQUALITY with the single
    // copy, so the duplication this script exists to catch (`TYPEDTYPED`) never
    // satisfies it and still fails on the full budget.
    const rendered = await waitFor(
      () => blockText(blockAfter),
      (text) => text === TYPED,
    );
    const dom = rendered.value;
    await snap(freshPage, out, `after-reopen-${round}`);
    console.log(
      `DOM after reopen ${round}:`,
      JSON.stringify(dom),
      `(after ${rendered.waitedMs}ms, ${rendered.attempts} reads)`,
    );
    r.ok(
      `DOM shows the text exactly once after reopen ${round}`,
      rendered.ok,
      JSON.stringify(dom),
    );

    // Both server reads were one-shot too. The reopened editor may still be
    // flushing — and that flush is exactly what a duplication bug corrupts — so
    // a single read races it. The demands are unchanged (equality, and the
    // occurrence count being exactly 1), so a doubled doc fails on the full
    // budget rather than passing on a lucky early read.
    const dataText = await waitFor(
      () => fetchBlockText(pageId, blockId),
      (text) => text === TYPED,
    );
    r.ok(
      `data.text is the single copy after reopen ${round}`,
      dataText.ok,
      JSON.stringify(dataText.value),
    );

    const docText = await waitFor(
      () => fetchDocText(blockId),
      (text) => countOccurrences(text, TYPED) === 1,
    );
    r.ok(
      `page_block_docs state decodes to a single copy after reopen ${round}`,
      countOccurrences(docText.value, TYPED) === 1,
      JSON.stringify(docText.value),
    );
    await freshCtx.close();
  }

  await reopenAndVerify(1);
  await reopenAndVerify(2); // must not compound

  await r.finish();
});
