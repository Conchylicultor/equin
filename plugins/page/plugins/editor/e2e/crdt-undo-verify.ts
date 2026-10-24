// Per-block CRDT undo verification — text entries as DATA
// (research/2026-09-09-page-data-based-text-undo-entries-v2.md; the pointer
// model it replaced was research/2026-07-07-page-per-block-crdt-plan-b.md
// §Undo/redo).
//
// Text edits ride the app's single document-level undo stack as self-contained
// `{blockId, before, after}` runs entries, recorded per idle-closed typing run
// by the block's run tracker; split/merge are ONE entry carrying the structural
// patch AND the doc edit. Replay brings the block to the recorded runs on
// whichever host holds it at that moment — its open doc, or its stored doc
// through the server — so an entry survives the block's editor unmounting, the
// block being deleted (a trash: its doc survives) and re-created.
//
// Phases:
//  1. typing undo/redo in one block (two separate runs → two entries);
//  2. chronological interleave across two blocks + a structural split (undo
//     reverses in exact reverse chronological order; redo re-applies forward —
//     INCLUDING redoing typing into a block whose creation was itself undone,
//     which the pointer model documented as a no-op and which is now the
//     headline assertion: the entry is data, so it restores "bravo");
//  3. split undo/redo consistency: one Cmd+Z removes the new block AND
//     restores the origin's full pre-split content; rows checked over HTTP;
//  4. merge undo/redo consistency: one Cmd+Z restores the merged-away block
//     (row + its surviving doc) AND un-appends the target; the source doc's
//     bytes are identical before the merge and after the undo;
//  5. convergence in a second browser context;
//  6. a FAST Cmd+Shift+Z pair on a re-created block (no sleep between the
//     two): the typing redo waits, push-based, for the re-created row to enter
//     server truth instead of doc-initing a row the server does not have yet;
//  7. bold typing, delete the block, Cmd+Z, Cmd+Z: the block comes back with
//     the mark intact and exactly one paragraph (its doc, not a re-seed), and
//     its stored doc bytes are identical before the delete and after the
//     restore; the second Cmd+Z reverts the typing (no silent no-op);
//  8. Cmd+Z INSIDE the 500 ms idle window undoes the run being typed (the
//     pending flush seals it first), not the entry below it.
//
// Usage: ./equin run plugins/page/plugins/editor/e2e/crdt-undo-verify.ts [--url <deploy>] [--out /tmp/undo]
import {
  agentFetch,
  arg,
  ELEMENT_TIMEOUT_MS,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Locator } from "playwright";
import * as Y from "yjs";
import { runsOf, runsToXmlText } from "@plugins/page/plugins/editor/core";
import { openBlankPage } from "./support/blank-page";
import { makeRunsReader, PROJECTION_MS } from "./support/runs";

const out = arg("out", "/tmp/undo");

const r = report();
const runsReader = makeRunsReader();

// NOT the barrel's `blockText()`: these assertions compare against text that
// legitimately carries an interior/leading space (" zulu" typed onto "alpha
// beta"), so this normalizer strips trailing newlines only — it never trims.
const norm = (s: string): string => s.replace(/ /g, " ").replace(/\n+$/, "");

interface BlockRow {
  id: string;
  type: string;
  data?: { text?: { text: string; marks?: string[] }[] };
}

async function fetchRows(pageId: string): Promise<BlockRow[]> {
  const res = await agentFetch(`/api/pages/${pageId}/blocks`);
  if (!res.ok) throw new Error(`blocks fetch ${res.status}`);
  const rows = (await res.json()) as BlockRow[];
  return rows.filter((row) => row.type !== "page");
}
const rowText = (row: BlockRow | undefined): string =>
  (row?.data?.text ?? []).map((run) => run.text).join("");

/**
 * The stored doc's state for a block, read through `doc-init` with the row's
 * OWN text as the proposal — the read the stored-doc replay host makes. The
 * proposal only matters for a block the server holds no doc for (first-writer-
 * wins seeds it from the row); for every block here a doc exists, so the
 * answer is the authoritative stored state, byte for byte. Returned base64 so
 * two reads can be compared for identity; `docText` decodes one.
 */
async function fetchDocState(pageId: string, blockId: string): Promise<string> {
  const row = (await fetchRows(pageId)).find((b) => b.id === blockId);
  // `runsOf` decodes the row's untyped `data.text` (absent ⇒ no runs).
  const seed = runsToXmlText(runsOf(row?.data?.text)).doc;
  if (!seed) throw new Error("seed XmlText is not attached to a doc");
  // Copy into an ArrayBuffer-backed view: yjs types its output as
  // Uint8Array<ArrayBufferLike>, which BodyInit rejects (it could be shared).
  const proposal = new Uint8Array(Y.encodeStateAsUpdate(seed));
  const res = await agentFetch(`/api/blocks/${blockId}/doc-init`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: proposal,
  });
  if (!res.ok) throw new Error(`doc-init read failed: ${res.status}`);
  const { state } = (await res.json()) as { state: string };
  return state;
}

/** Plain text and paragraph count of a stored state (the lexical `root` XmlText). */
function docText(stateB64: string): { text: string; paragraphs: number } {
  const bytes = Uint8Array.from(atob(stateB64), (c) => c.charCodeAt(0));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  const root = doc.get("root", Y.XmlText);
  let text = "";
  let paragraphs = 0;
  for (const op of root.toDelta() as { insert?: unknown }[]) {
    if (op.insert instanceof Y.XmlText) {
      paragraphs += 1;
      for (const run of op.insert.toDelta() as { insert?: unknown }[]) {
        if (typeof run.insert === "string") text += run.insert;
      }
    }
  }
  return { text, paragraphs };
}

await withBrowser(async (h) => {
  const { page: pageA } = await h.session({ label: "A" });

  const {
    pageUrl,
    pageId,
    block: blockA,
    blockId: idA,
  } = await openBlankPage(pageA, { settleMs: 3000 });
  console.log("page url:", pageUrl);
  console.log("PAGE_ID:", pageId);
  console.log("BLOCK_A:", idA);

  // The block ids stay nullable on purpose: when a phase fails to find the block
  // it just created, the locator resolves to `[data-block-id="null"]` and the
  // assertion reports the miss — the pre-move behaviour, kept verbatim.
  const editorOf = (id: string | null): Locator =>
    pageA.locator(`[data-block-id="${id}"] [contenteditable="true"]`).first();
  const textOf = async (id: string | null): Promise<string> =>
    norm(await editorOf(id).innerText());
  const blockCount = (): Promise<number> =>
    pageA.locator(`[data-block-id]:has([contenteditable="true"])`).count();
  const paragraphsOf = (id: string | null): Promise<number> =>
    editorOf(id).locator("p").count();
  /** The editable block id not among `known` — the one a split just minted. */
  const newBlockId = (known: (string | null)[]): Promise<string | null> =>
    pageA.evaluate<string | null, (string | null)[]>(
      (ids) =>
        [...document.querySelectorAll("[data-block-id]")]
          .filter((el) => el.querySelector('[contenteditable="true"]'))
          .map((el) => el.getAttribute("data-block-id"))
          .find((id) => !ids.includes(id)) ?? null,
      known,
    );

  async function clickEnd(id: string | null): Promise<void> {
    const el = editorOf(id);
    const box = await el.boundingBox();
    if (!box) throw new Error(`no bounding box for block ${id}`);
    await el.click({
      position: {
        x: Math.max(2, box.width - 4),
        y: Math.min(14, box.height / 2),
      },
    });
    await pageA.waitForTimeout(250);
  }
  async function clickStart(id: string | null): Promise<void> {
    await editorOf(id).click({ position: { x: 2, y: 12 } });
    await pageA.waitForTimeout(250);
  }
  const undo = async (ms = 600): Promise<void> => {
    await pageA.keyboard.press("Meta+z");
    await pageA.waitForTimeout(ms);
  };
  const redo = async (ms = 600): Promise<void> => {
    await pageA.keyboard.press("Meta+Shift+z");
    await pageA.waitForTimeout(ms);
  };
  /** Delete the block the caret is in: Escape selects it, Backspace removes it. */
  const deleteCurrentBlock = async (): Promise<void> => {
    await pageA.keyboard.press("Escape");
    await pageA.waitForTimeout(150);
    await pageA.keyboard.press("Backspace");
    await pageA.waitForTimeout(800);
  };

  // --- Phase 1: typing undo/redo in one block ---------------------------------
  await blockA.click();
  await pageA.keyboard.type("alpha", { delay: 20 });
  await pageA.waitForTimeout(900); // > the run tracker's idle window → next run = new entry
  await pageA.keyboard.type(" beta", { delay: 20 });
  await pageA.waitForTimeout(1800); // flush + projection
  r.ok("P1 compose", (await textOf(idA)) === "alpha beta", await textOf(idA));

  await undo();
  r.ok("P1 undo run2", (await textOf(idA)) === "alpha", await textOf(idA));
  await undo();
  r.ok("P1 undo run1 (empty)", (await textOf(idA)) === "", await textOf(idA));
  await redo();
  r.ok("P1 redo run1", (await textOf(idA)) === "alpha", await textOf(idA));
  await redo();
  r.ok("P1 redo run2", (await textOf(idA)) === "alpha beta", await textOf(idA));
  await snap(pageA, out, "1-typing");

  // --- Phase 2: chronological interleave (A-typing / split / B-typing) --------
  await pageA.waitForTimeout(900);
  await clickEnd(idA);
  await pageA.keyboard.press("Enter"); // split at end → new empty block B
  await pageA.waitForTimeout(800);
  r.ok(
    "P2 split created block",
    (await blockCount()) === 2,
    `count=${await blockCount()}`,
  );
  const idB = await newBlockId([idA]);
  console.log("BLOCK_B:", idB);
  await pageA.keyboard.type("bravo", { delay: 20 }); // caret focused into B by the split
  await pageA.waitForTimeout(900);
  r.ok("P2 typed in B", (await textOf(idB)) === "bravo", await textOf(idB));
  await clickEnd(idA);
  await pageA.keyboard.type(" zulu", { delay: 20 });
  await pageA.waitForTimeout(1800);
  r.ok(
    "P2 typed in A",
    (await textOf(idA)) === "alpha beta zulu",
    await textOf(idA),
  );

  // Undo chain: exact reverse chronological order.
  await undo();
  r.ok(
    "P2 undo1 reverts A-zulu",
    (await textOf(idA)) === "alpha beta" && (await textOf(idB)) === "bravo",
  );
  await undo();
  r.ok(
    "P2 undo2 reverts B-bravo",
    (await textOf(idB)) === "" && (await textOf(idA)) === "alpha beta",
  );
  await undo();
  r.ok(
    "P2 undo3 reverts split (B gone)",
    (await blockCount()) === 1 && (await textOf(idA)) === "alpha beta",
  );
  // Redo chain forward. THE HEADLINE: redoing the typing into B — a block whose
  // creation was undone (B was deleted, i.e. trashed, and is re-created by the
  // split's redo) — restores "bravo". The entry is data replayed onto the
  // re-created block's doc; under the pointer model it was a documented no-op.
  await redo();
  r.ok(
    "P2 redo split (B back, empty)",
    (await blockCount()) === 2 && (await textOf(idB)) === "",
  );
  await redo();
  {
    // The replay may wait for the re-created row to enter server truth before
    // it can touch the stored doc, so read until it lands rather than once.
    const restored = await waitFor(
      async () => await textOf(idB),
      (text) => text === "bravo",
    );
    r.ok("P2 redo B-typing restores 'bravo'", restored.ok, restored.value);
  }
  await redo();
  r.ok(
    "P2 redo A-zulu",
    (await textOf(idA)) === "alpha beta zulu",
    await textOf(idA),
  );
  await snap(pageA, out, "2-interleave");

  // --- Phase 3: split undo/redo consistency ------------------------------------
  await clickStart(idB);
  for (let i = 0; i < 3; i++) {
    await pageA.keyboard.press("ArrowRight");
    await pageA.waitForTimeout(60);
  }
  await pageA.waitForTimeout(300);
  await pageA.keyboard.press("Enter"); // split "bra|vo"
  await pageA.waitForTimeout(1000);
  const idC = await newBlockId([idA, idB]);
  console.log("BLOCK_C:", idC);
  r.ok(
    "P3 split DOM",
    (await textOf(idB)) === "bra" &&
      idC !== null &&
      (await textOf(idC)) === "vo",
  );
  await pageA.waitForTimeout(2500); // projection
  {
    const rows = await fetchRows(pageId);
    const b = rows.find((row) => row.id === idB);
    const c = rows.find((row) => row.id === idC);
    r.ok(
      "P3 rows after split",
      rowText(b) === "bra" && rowText(c) === "vo",
      JSON.stringify({ b: rowText(b), c: rowText(c) }),
    );
  }

  await undo(800); // ONE undo reverses rows AND docs together
  r.ok(
    "P3 undo split: C gone + B fully restored",
    (await blockCount()) === 2 && (await textOf(idB)) === "bravo",
    `count=${await blockCount()} B=${await textOf(idB)}`,
  );
  await pageA.waitForTimeout(2500);
  {
    const rows = await fetchRows(pageId);
    const b = rows.find((row) => row.id === idB);
    const c = rows.find((row) => row.id === idC);
    r.ok(
      "P3 rows after undo-split",
      rowText(b) === "bravo" && c === undefined,
      JSON.stringify({ b: rowText(b), c: c ? rowText(c) : null }),
    );
  }
  await snap(pageA, out, "3-undo-split");

  await redo(800);
  r.ok(
    "P3 redo split: C back + B truncated",
    (await textOf(idB)) === "bra" && (await textOf(idC)) === "vo",
    `B=${await textOf(idB)} C=${idC ? await textOf(idC) : "?"}`,
  );
  await pageA.waitForTimeout(2500);
  {
    const rows = await fetchRows(pageId);
    const b = rows.find((row) => row.id === idB);
    const c = rows.find((row) => row.id === idC);
    r.ok(
      "P3 rows after redo-split",
      rowText(b) === "bra" && rowText(c) === "vo",
      JSON.stringify({ b: rowText(b), c: c ? rowText(c) : null }),
    );
  }
  await undo(800); // back to B="bravo", C gone — clean state for phase 4
  r.ok(
    "P3 second undo-split",
    (await blockCount()) === 2 && (await textOf(idB)) === "bravo",
  );
  await pageA.waitForTimeout(2500);

  // --- Phase 4: merge undo/redo consistency ------------------------------------
  // The source's stored doc before the merge: the merge is a trash, so the doc
  // survives and undo binds the restored row back to it — byte-identical.
  const bDocBeforeMerge = await fetchDocState(pageId, idB!);
  await clickStart(idB);
  await pageA.keyboard.press("Backspace"); // merge B into A
  await pageA.waitForTimeout(1200);
  r.ok(
    "P4 merge DOM",
    (await blockCount()) === 1 &&
      (await textOf(idA)) === "alpha beta zulubravo",
    `count=${await blockCount()} A=${await textOf(idA)}`,
  );
  await pageA.waitForTimeout(2500);
  {
    const rows = await fetchRows(pageId);
    const a = rows.find((row) => row.id === idA);
    r.ok(
      "P4 rows after merge",
      rowText(a) === "alpha beta zulubravo" && rows.length === 1,
      JSON.stringify({ a: rowText(a), n: rows.length }),
    );
  }

  await undo(1000); // ONE undo: B row+doc restored, A un-appended
  r.ok(
    "P4 undo merge: B restored + A un-appended",
    (await blockCount()) === 2 &&
      (await textOf(idA)) === "alpha beta zulu" &&
      (await textOf(idB)) === "bravo",
    `A=${await textOf(idA)} B=${(await blockCount()) === 2 ? await textOf(idB) : "?"}`,
  );
  await pageA.waitForTimeout(2500);
  {
    const rows = await fetchRows(pageId);
    const a = rows.find((row) => row.id === idA);
    const b = rows.find((row) => row.id === idB);
    r.ok(
      "P4 rows after undo-merge",
      rowText(a) === "alpha beta zulu" && rowText(b) === "bravo",
      JSON.stringify({ a: rowText(a), b: b ? rowText(b) : null }),
    );
    const bDocAfterUndo = await fetchDocState(pageId, idB!);
    r.ok(
      "P4 source doc bytes identical before merge and after undo",
      bDocAfterUndo === bDocBeforeMerge,
      JSON.stringify({
        before: docText(bDocBeforeMerge),
        after: docText(bDocAfterUndo),
      }),
    );
  }
  await snap(pageA, out, "4-undo-merge");

  await redo(1000);
  r.ok(
    "P4 redo merge",
    (await blockCount()) === 1 &&
      (await textOf(idA)) === "alpha beta zulubravo",
  );
  await undo(1000); // final resting state: A + B
  r.ok(
    "P4 final undo-merge",
    (await blockCount()) === 2 &&
      (await textOf(idA)) === "alpha beta zulu" &&
      (await textOf(idB)) === "bravo",
  );
  await pageA.waitForTimeout(3000); // let projection + flush land for convergence/DB

  // --- Phase 5: convergence in a second context --------------------------------
  const { page: pageB } = await h.session({ label: "B" });
  await pageB.goto(pageUrl);
  const aB = pageB
    .locator(`[data-block-id="${idA}"] [contenteditable="true"]`)
    .first();
  await aB.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  const bB = pageB
    .locator(`[data-block-id="${idB}"] [contenteditable="true"]`)
    .first();
  // Was a fixed `waitForTimeout(5000)` before three separate reads. A second
  // context measured 6.7-11.2s to render text against main, so the reads could
  // land early and report a convergence failure that was the clock, not the app
  // — the same pattern already fixed in crdt-offline / crdt-newblock /
  // crdt-typing / crdt-split-merge. All three demands are unchanged.
  const converged = await waitFor(
    async () => ({
      a: norm(await aB.innerText()),
      b: norm(await bB.innerText()),
      n: await pageB
        .locator('[data-block-id]:has([contenteditable="true"])')
        .count(),
    }),
    ({ a, b, n }) => a === "alpha beta zulu" && b === "bravo" && n === 2,
  );
  await snap(pageB, out, "5-context-b");
  console.log(
    `context B converged after ${converged.waitedMs}ms (${converged.attempts} reads)`,
  );
  r.ok("P5 convergence", converged.ok, JSON.stringify(converged.value));
  await pageB.close();

  // --- Phase 6: a FAST redo pair on a re-created block -------------------------
  // split (creates D) → type "delta" → undo typing → undo split → redo, redo
  // with NO sleep between the two redos. The split's redo re-creates D
  // optimistically; the typing's redo must not doc-init a row the server may
  // not have yet — it waits, push-based, for the row to enter server truth
  // (the pointer model's e2e only passed here thanks to a 600 ms sleep).
  await clickEnd(idB);
  await pageA.keyboard.press("Enter");
  await pageA.waitForTimeout(800);
  const idD = await newBlockId([idA, idB, idC]);
  console.log("BLOCK_D:", idD);
  await pageA.keyboard.type("delta", { delay: 20 });
  await pageA.waitForTimeout(1500);
  r.ok("P6 typed in D", (await textOf(idD)) === "delta", await textOf(idD));
  await undo();
  await undo();
  r.ok(
    "P6 undone back to 2 blocks",
    (await blockCount()) === 2,
    `count=${await blockCount()}`,
  );
  await pageA.keyboard.press("Meta+Shift+z");
  await pageA.keyboard.press("Meta+Shift+z"); // immediately — no sleep
  {
    const restored = await waitFor(
      async () => ({ n: await blockCount(), d: await textOf(idD) }),
      ({ n, d }) => n === 3 && d === "delta",
    );
    r.ok(
      "P6 fast redo pair: D re-created AND 'delta' restored",
      restored.ok,
      JSON.stringify(restored.value),
    );
  }
  await pageA.waitForTimeout(PROJECTION_MS);
  {
    const d = (await fetchRows(pageId)).find((row) => row.id === idD);
    r.ok("P6 row after fast redo pair", rowText(d) === "delta", rowText(d));
  }
  await snap(pageA, out, "6-fast-redo");

  // --- Phase 7: bold typing, delete block, Cmd+Z, Cmd+Z ------------------------
  // The reported incident, with a mark on the text so a re-seed from the row
  // (which would lose nothing here but is the wrong source) and a duplicated
  // paragraph (the pre-`RowTruth` pre-seed hazard) are both observable.
  await clickEnd(idD);
  await pageA.keyboard.press("Enter");
  await pageA.waitForTimeout(800);
  const idE = await newBlockId([idA, idB, idC, idD]);
  console.log("BLOCK_E:", idE);
  await pageA.keyboard.press("Meta+b");
  await pageA.keyboard.type("emphatic", { delay: 20 });
  await pageA.waitForTimeout(1500); // run closed, flushed
  {
    const runs = await runsReader.settledRuns(pageA, pageId, idE!);
    r.eq("P7 bold typed and persisted", runs, [
      { text: "emphatic", marks: ["bold"] },
    ]);
  }
  const eDocBeforeDelete = await fetchDocState(pageId, idE!);
  r.ok(
    "P7 stored doc before delete holds the bold paragraph",
    docText(eDocBeforeDelete).text === "emphatic" &&
      docText(eDocBeforeDelete).paragraphs === 1,
    JSON.stringify(docText(eDocBeforeDelete)),
  );
  await deleteCurrentBlock();
  r.ok(
    "P7 block deleted",
    (await blockCount()) === 3,
    `count=${await blockCount()}`,
  );
  await pageA.waitForTimeout(1500); // the delete lands server-side (a trash)

  await undo(1500);
  {
    const back = await waitFor(
      async () => ({
        n: await blockCount(),
        text: await textOf(idE),
        paragraphs: await paragraphsOf(idE),
        bold: await editorOf(idE).locator("strong").count(),
      }),
      ({ n, text, paragraphs, bold }) =>
        n === 4 && text === "emphatic" && paragraphs === 1 && bold === 1,
    );
    r.ok(
      "P7 undo delete: block back, mark intact, exactly one paragraph",
      back.ok,
      JSON.stringify(back.value),
    );
  }
  await pageA.waitForTimeout(PROJECTION_MS);
  {
    const eDocAfterRestore = await fetchDocState(pageId, idE!);
    r.ok(
      "P7 doc bytes before delete == after restore",
      eDocAfterRestore === eDocBeforeDelete,
      JSON.stringify({
        before: docText(eDocBeforeDelete),
        after: docText(eDocAfterRestore),
        sameLength: eDocAfterRestore.length === eDocBeforeDelete.length,
      }),
    );
  }
  await snap(pageA, out, "7-undo-delete");

  // The second Cmd+Z reverts the TYPING into the restored block — the exact
  // press that used to be a silent no-op.
  await undo(1500);
  {
    const reverted = await waitFor(
      async () => ({ n: await blockCount(), text: await textOf(idE) }),
      ({ n, text }) => n === 4 && text === "",
    );
    r.ok(
      "P7 undo again reverts the typing (no silent no-op)",
      reverted.ok,
      JSON.stringify(reverted.value),
    );
  }
  await redo(1500);
  {
    const redone = await waitFor(
      async () => ({
        text: await textOf(idE),
        bold: await editorOf(idE).locator("strong").count(),
      }),
      ({ text, bold }) => text === "emphatic" && bold === 1,
    );
    r.ok(
      "P7 redo restores the bold typing",
      redone.ok,
      JSON.stringify(redone.value),
    );
  }
  await pageA.waitForTimeout(PROJECTION_MS);

  // --- Phase 8: Cmd+Z inside the idle window -----------------------------------
  // The run being typed is sealed by the pending flush at the start of the undo
  // turn, so it is the entry popped — not the redo of phase 7 below it.
  await clickEnd(idE);
  await pageA.keyboard.press("Enter");
  await pageA.waitForTimeout(800);
  const idF = await newBlockId([idA, idB, idC, idD, idE]);
  console.log("BLOCK_F:", idF);
  await pageA.keyboard.type("fast", { delay: 20 });
  await pageA.keyboard.press("Meta+z"); // well inside the 500 ms idle window
  await pageA.waitForTimeout(800);
  r.ok(
    "P8 undo inside the idle window undoes the run being typed",
    (await textOf(idF)) === "" &&
      (await textOf(idE)) === "emphatic" &&
      (await blockCount()) === 5,
    JSON.stringify({
      f: await textOf(idF),
      e: await textOf(idE),
      n: await blockCount(),
    }),
  );
  await snap(pageA, out, "8-idle-window-undo");

  console.log("BLOCK_A:", idA);
  console.log("BLOCK_B:", idB);
  console.log("BLOCK_C:", idC);
  console.log("BLOCK_D:", idD);
  console.log("BLOCK_E:", idE);
  console.log("BLOCK_F:", idF);
  console.log("PAGE_ID:", pageId);
  console.log("PAGE_URL:", pageUrl);

  await r.finish();
});
