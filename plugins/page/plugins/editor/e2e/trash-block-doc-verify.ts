// Every block delete is a trash — the server invariant, observed over HTTP
// (research/2026-09-09-page-data-based-text-undo-entries-v2.md §3.1, §7).
//
// A delete soft-deletes its rows under one ledger entry and never touches
// `page_block_docs`: while a block is trashed its stored doc still answers
// `doc-init` with the SAME bytes, its row is addressable by no id-scoped
// endpoint (404, like an unknown id), and an undo brings the row back bound to
// that surviving doc — no re-seed from the ~1 s-lagged `data.text` projection.
// The sibling `crdt-undo-verify.ts` phase 7 asserts the client-visible half of
// the same incident; this script pins the SERVER half, byte for byte, and adds
// the block no editor ever opened.
//
// Phases:
//  1. type marked text (bold + plain) into block A; snapshot A's stored doc;
//  2. delete A the way a user does (Escape selects the block, Backspace removes
//     it); the row leaves server truth;
//  3. while trashed: `doc-init` returns byte-identical state, A is absent from
//     GET rows, and the id-addressed PATCH / DELETE answer 404;
//  4. Cmd+Z: the row is back, the mark intact, exactly one paragraph, and the
//     doc bytes identical to the snapshot; then Cmd+Shift+Z re-trashes A (rows
//     gone, doc still readable, same bytes) and Cmd+Z restores it once more;
//  5. a NEVER-OPENED block: a collapsed toggle T with a hidden child B, both
//     created over HTTP while no editor was on the page, B's doc seeded with
//     text the row does NOT carry (so a re-seed from the row is observable);
//     delete T with the keyboard (B travels with it), Cmd+Z; B's row is back,
//     its doc bytes unchanged, and once T is expanded B renders the DOC's text;
//  6. Cmd+Shift+Z re-trashes T and B (both rows gone, B's doc still readable);
//     Cmd+Z restores them and B still renders the doc's text.
//
// Usage: ./equin run plugins/page/plugins/editor/e2e/trash-block-doc-verify.ts [--url <deploy>] [--out /tmp/trash-doc]
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
import {
  runsOf,
  runsToXmlText,
  type TextRun,
} from "@plugins/page/plugins/editor/core";
import { openBlankPage } from "./support/blank-page";
import { makeRunsReader, PROJECTION_MS } from "./support/runs";

const out = arg("out", "/tmp/trash-doc");

const r = report();
const runsReader = makeRunsReader();

// Trailing newlines only — never trim: the assertions compare against text
// that legitimately carries an interior space ("bold plain").
const norm = (s: string): string => s.replace(/ /g, " ").replace(/\n+$/, "");

interface BlockRow {
  id: string;
  type: string;
  parentId: string | null;
  expanded: boolean;
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
const rowIds = async (pageId: string): Promise<string[]> =>
  (await fetchRows(pageId)).map((row) => row.id);

/** The v1 update encoding of a fresh doc seeded from `runs` — a doc-init proposal. */
function proposalOf(runs: TextRun[]): Uint8Array<ArrayBuffer> {
  const seed = runsToXmlText(runs).doc;
  if (!seed) throw new Error("seed XmlText is not attached to a doc");
  // Copy into an ArrayBuffer-backed view: yjs types its output as
  // Uint8Array<ArrayBufferLike>, which BodyInit rejects (it could be shared).
  return new Uint8Array(Y.encodeStateAsUpdate(seed));
}

/**
 * `doc-init` with an explicit proposal: first-writer-wins, so the answer is the
 * stored state when one exists and the proposal itself when this call seeds
 * it. Returned base64 so two reads can be compared for identity; `docText`
 * decodes one. Throws on a non-2xx: a 404 here means the doc's block row is
 * GONE (purged), which no phase of this script expects.
 */
async function docInit(blockId: string, runs: TextRun[]): Promise<string> {
  const res = await agentFetch(`/api/blocks/${blockId}/doc-init`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: proposalOf(runs),
  });
  if (!res.ok) throw new Error(`doc-init ${blockId} failed: ${res.status}`);
  const { state } = (await res.json()) as { state: string };
  return state;
}

/**
 * The stored doc's state for a block, read through `doc-init` with the row's
 * OWN text as the proposal — the read the stored-doc replay host makes. For a
 * TRASHED block the row is not in GET rows, so the proposal is empty runs;
 * that only matters for a block with no doc, and every block read this way
 * already has one.
 */
async function fetchDocState(pageId: string, blockId: string): Promise<string> {
  const row = (await fetchRows(pageId)).find((b) => b.id === blockId);
  return docInit(blockId, runsOf(row?.data?.text));
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

async function postJson(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<Response> {
  return agentFetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createBlock(body: {
  parentId?: string;
  afterId?: string;
  type: string;
  data: unknown;
}): Promise<string> {
  const res = await postJson("/api/blocks", "POST", body);
  if (!res.ok) {
    throw new Error(`POST /api/blocks ${res.status}: ${await res.text()}`);
  }
  const { id } = (await res.json()) as { id: string };
  return id;
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

  const editorOf = (id: string): Locator =>
    pageA.locator(`[data-block-id="${id}"] [contenteditable="true"]`).first();
  const textOf = async (id: string): Promise<string> =>
    norm(await editorOf(id).innerText());
  const rendered = (id: string): Promise<number> =>
    pageA
      .locator(`[data-block-id="${id}"]:has([contenteditable="true"])`)
      .count();
  const paragraphsOf = (id: string): Promise<number> =>
    editorOf(id).locator("p").count();
  const boldOf = (id: string): Promise<number> =>
    editorOf(id).locator("strong").count();

  async function clickEnd(id: string): Promise<void> {
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
  const undo = async (ms = 800): Promise<void> => {
    await pageA.keyboard.press("Meta+z");
    await pageA.waitForTimeout(ms);
  };
  const redo = async (ms = 800): Promise<void> => {
    await pageA.keyboard.press("Meta+Shift+z");
    await pageA.waitForTimeout(ms);
  };
  /** Delete the block the caret is in: Escape selects it, Backspace removes it. */
  const deleteCurrentBlock = async (): Promise<void> => {
    await pageA.keyboard.press("Escape");
    await pageA.waitForTimeout(150);
    await pageA.keyboard.press("Backspace");
    await pageA.waitForTimeout(400);
  };
  /** Push-based: the row set, read until `ok` holds. */
  const rowsSettle = (ok: (ids: string[]) => boolean) =>
    waitFor(() => rowIds(pageId), ok);

  // --- Phase 1: marked text into A, snapshot its doc ---------------------------
  await blockA.click();
  await pageA.keyboard.press("Meta+b");
  await pageA.keyboard.type("bold", { delay: 20 });
  await pageA.keyboard.press("Meta+b");
  await pageA.keyboard.type(" plain", { delay: 20 });
  await pageA.waitForTimeout(1500); // run closed, flushed
  r.ok(
    "P1 DOM: bold + plain in one paragraph",
    (await textOf(idA)) === "bold plain" &&
      (await boldOf(idA)) === 1 &&
      (await paragraphsOf(idA)) === 1,
    JSON.stringify({
      text: await textOf(idA),
      bold: await boldOf(idA),
      paragraphs: await paragraphsOf(idA),
    }),
  );
  {
    const runs = await runsReader.settledRuns(pageA, pageId, idA);
    r.eq("P1 runs persisted (bold, plain)", runs, [
      { text: "bold", marks: ["bold"] },
      { text: " plain", marks: [] },
    ]);
  }
  const aDocBefore = await fetchDocState(pageId, idA);
  r.ok(
    "P1 stored doc holds the paragraph",
    docText(aDocBefore).text === "bold plain" &&
      docText(aDocBefore).paragraphs === 1,
    JSON.stringify(docText(aDocBefore)),
  );
  // A second block, so the page is never empty and the delete is the ordinary
  // "one block among others" gesture.
  await clickEnd(idA);
  await pageA.keyboard.press("Enter");
  await pageA.waitForTimeout(600);
  await pageA.keyboard.type("keeper", { delay: 20 });
  await pageA.waitForTimeout(1500);
  const idK = (await rowsSettle((ids) => ids.length === 2)).value.find(
    (id) => id !== idA,
  );
  if (!idK) throw new Error("the split's new block never reached server truth");
  console.log("BLOCK_K:", idK);
  await snap(pageA, out, "1-typed");

  // --- Phase 2: delete A with the keyboard --------------------------------------
  await clickEnd(idA);
  await deleteCurrentBlock();
  r.ok(
    "P2 A unmounted",
    (await rendered(idA)) === 0,
    `rendered=${await rendered(idA)}`,
  );
  {
    const gone = await rowsSettle((ids) => !ids.includes(idA));
    r.ok(
      "P2 A left server truth (trashed)",
      gone.ok,
      JSON.stringify(gone.value),
    );
  }

  // --- Phase 3: while trashed --------------------------------------------------
  {
    const aDocTrashed = await fetchDocState(pageId, idA);
    r.ok(
      "P3 doc-init on the trashed block returns the SAME bytes",
      aDocTrashed === aDocBefore,
      JSON.stringify({
        before: docText(aDocBefore),
        trashed: docText(aDocTrashed),
      }),
    );
    const ids = await rowIds(pageId);
    r.ok(
      "P3 trashed row is absent from GET rows (keeper stays)",
      !ids.includes(idA) && ids.includes(idK),
      JSON.stringify(ids),
    );
    const patch = await postJson(`/api/blocks/${idA}`, "PATCH", {
      expanded: true,
    });
    r.ok(
      "P3 PATCH on a trashed id → 404",
      patch.status === 404,
      `status=${patch.status}`,
    );
    const del = await agentFetch(`/api/blocks/${idA}`, { method: "DELETE" });
    r.ok(
      "P3 DELETE on a trashed id → 404",
      del.status === 404,
      `status=${del.status}`,
    );
    // The 404s must not have touched the ledger: the row is still trashed and
    // its doc still answers.
    r.ok(
      "P3 still trashed after the 404s, doc still identical",
      !(await rowIds(pageId)).includes(idA) &&
        (await fetchDocState(pageId, idA)) === aDocBefore,
    );
  }
  await snap(pageA, out, "3-trashed");

  // --- Phase 4: Cmd+Z restores the row onto its surviving doc ------------------
  await undo();
  {
    const back = await waitFor(
      async () => ({
        rendered: await rendered(idA),
        text: (await rendered(idA)) ? await textOf(idA) : null,
        paragraphs: (await rendered(idA)) ? await paragraphsOf(idA) : -1,
        bold: (await rendered(idA)) ? await boldOf(idA) : -1,
      }),
      (v) =>
        v.rendered === 1 &&
        v.text === "bold plain" &&
        v.paragraphs === 1 &&
        v.bold === 1,
    );
    r.ok(
      "P4 undo: A back, mark intact, exactly one paragraph",
      back.ok,
      JSON.stringify(back.value),
    );
    const rows = await rowsSettle((ids) => ids.includes(idA));
    r.ok(
      "P4 undo: A back in server truth",
      rows.ok,
      JSON.stringify(rows.value),
    );
  }
  await pageA.waitForTimeout(PROJECTION_MS);
  {
    const aDocRestored = await fetchDocState(pageId, idA);
    r.ok(
      "P4 doc bytes before delete == after restore",
      aDocRestored === aDocBefore,
      JSON.stringify({
        before: docText(aDocBefore),
        after: docText(aDocRestored),
        sameLength: aDocRestored.length === aDocBefore.length,
      }),
    );
    const a = (await fetchRows(pageId)).find((row) => row.id === idA);
    r.ok("P4 restored row text", rowText(a) === "bold plain", rowText(a));
  }
  await snap(pageA, out, "4-restored");

  // Redo re-trashes A: rows gone, doc still readable and identical; undo again.
  await redo();
  {
    const gone = await rowsSettle((ids) => !ids.includes(idA));
    r.ok(
      "P4 redo re-trashes A (row gone, unmounted)",
      gone.ok && (await rendered(idA)) === 0,
      JSON.stringify({ ids: gone.value, rendered: await rendered(idA) }),
    );
    const aDocReTrashed = await fetchDocState(pageId, idA);
    r.ok(
      "P4 redo: doc still readable, same bytes",
      aDocReTrashed === aDocBefore,
      JSON.stringify(docText(aDocReTrashed)),
    );
  }
  await undo();
  {
    const back = await waitFor(
      async () => ({
        rendered: await rendered(idA),
        text: (await rendered(idA)) ? await textOf(idA) : null,
        bold: (await rendered(idA)) ? await boldOf(idA) : -1,
        paragraphs: (await rendered(idA)) ? await paragraphsOf(idA) : -1,
      }),
      (v) =>
        v.rendered === 1 &&
        v.text === "bold plain" &&
        v.bold === 1 &&
        v.paragraphs === 1,
    );
    r.ok("P4 undo again restores A", back.ok, JSON.stringify(back.value));
    const rows = await rowsSettle((ids) => ids.includes(idA));
    r.ok(
      "P4 undo again: A in server truth",
      rows.ok,
      JSON.stringify(rows.value),
    );
  }
  await pageA.waitForTimeout(PROJECTION_MS);
  r.ok(
    "P4 doc bytes still identical after redo + undo",
    (await fetchDocState(pageId, idA)) === aDocBefore,
  );

  // --- Phase 5: a block no editor ever opened -----------------------------------
  // Leave the page so nothing renders while the rows are minted: a child under
  // an expanded parent would mount an editor and doc-init itself. The toggle is
  // collapsed over HTTP BEFORE the page is reopened, so B never renders here.
  await pageA.goto(pageUrl.replace(/\/pages\/.*$/, "/pages"), {
    waitUntil: "domcontentloaded",
    timeout: ELEMENT_TIMEOUT_MS,
  });
  await pageA.waitForTimeout(500);
  const idT = await createBlock({
    afterId: idK,
    type: "toggle",
    data: { text: [{ text: "container" }] },
  });
  const idB = await createBlock({
    parentId: idT,
    type: "text",
    data: { text: [{ text: "hidden child" }] },
  });
  console.log("BLOCK_T:", idT);
  console.log("BLOCK_B:", idB);
  {
    const collapse = await postJson(`/api/blocks/${idT}`, "PATCH", {
      expanded: false,
    });
    if (!collapse.ok) throw new Error(`collapse toggle ${collapse.status}`);
  }
  // Seed B's doc with text its ROW does not carry. First-writer-wins: the
  // answer is this proposal iff no editor ever opened B — and from here on,
  // whatever renders B shows which source it was bound to.
  const B_DOC_TEXT = "hidden child from doc";
  const bDocBefore = await docInit(idB, [{ text: B_DOC_TEXT }]);
  r.ok(
    "P5 B's doc seeded by this script (no editor ever opened it)",
    docText(bDocBefore).text === B_DOC_TEXT &&
      docText(bDocBefore).paragraphs === 1,
    JSON.stringify(docText(bDocBefore)),
  );

  await pageA.goto(pageUrl, {
    waitUntil: "domcontentloaded",
    timeout: ELEMENT_TIMEOUT_MS,
  });
  await editorOf(idT).waitFor({
    state: "visible",
    timeout: ELEMENT_TIMEOUT_MS,
  });
  await pageA.waitForTimeout(3000);
  r.ok(
    "P5 toggle rendered collapsed, child hidden",
    (await rendered(idT)) === 1 && (await rendered(idB)) === 0,
    JSON.stringify({ t: await rendered(idT), b: await rendered(idB) }),
  );
  await snap(pageA, out, "5-collapsed-toggle");

  await clickEnd(idT);
  await deleteCurrentBlock();
  {
    const gone = await rowsSettle(
      (ids) => !ids.includes(idT) && !ids.includes(idB),
    );
    r.ok(
      "P5 deleting the toggle trashes it AND its hidden child",
      gone.ok && (await rendered(idT)) === 0,
      JSON.stringify(gone.value),
    );
    const bDocTrashed = await docInit(idB, [{ text: "hidden child" }]);
    r.ok(
      "P5 B's doc survives the trash, same bytes",
      bDocTrashed === bDocBefore,
      JSON.stringify(docText(bDocTrashed)),
    );
  }

  await undo();
  {
    const rows = await rowsSettle(
      (ids) => ids.includes(idT) && ids.includes(idB),
    );
    r.ok(
      "P5 undo: T and B back in server truth",
      rows.ok,
      JSON.stringify(rows.value),
    );
    const all = await fetchRows(pageId);
    const b = all.find((row) => row.id === idB);
    const t = all.find((row) => row.id === idT);
    r.ok(
      "P5 undo: B's row keeps its text and parent, T still collapsed",
      rowText(b) === "hidden child" &&
        b?.parentId === idT &&
        t?.expanded === false,
      JSON.stringify({
        b: rowText(b),
        parent: b?.parentId,
        tExpanded: t?.expanded,
      }),
    );
    const bDocRestored = await fetchDocState(pageId, idB);
    r.ok(
      "P5 undo: B's doc bytes unchanged",
      bDocRestored === bDocBefore,
      JSON.stringify(docText(bDocRestored)),
    );
    r.ok(
      "P5 undo: T rendered, B still hidden (collapsed)",
      (await rendered(idT)) === 1 && (await rendered(idB)) === 0,
    );
  }
  // Open the toggle: B mounts for the first time ever and must bind to the
  // stored doc — its DOM text is the doc's, not the row's.
  {
    const expand = await postJson(`/api/blocks/${idT}`, "PATCH", {
      expanded: true,
    });
    if (!expand.ok) throw new Error(`expand toggle ${expand.status}`);
    const shown = await waitFor(
      async () => ((await rendered(idB)) ? await textOf(idB) : null),
      (text) => text === B_DOC_TEXT,
    );
    r.ok(
      "P5 B renders the DOC's text once opened (no re-seed from the row)",
      shown.ok,
      JSON.stringify(shown.value),
    );
    r.ok("P5 B has exactly one paragraph", (await paragraphsOf(idB)) === 1);
  }
  await pageA.waitForTimeout(PROJECTION_MS);
  const bDocOpened = await fetchDocState(pageId, idB);
  r.ok(
    "P5 opening B changed none of its doc bytes",
    bDocOpened === bDocBefore,
    JSON.stringify({
      before: docText(bDocBefore),
      opened: docText(bDocOpened),
    }),
  );
  await snap(pageA, out, "5-opened");

  // --- Phase 6: redo re-trashes the container, undo restores it ---------------
  await redo();
  {
    const gone = await rowsSettle(
      (ids) => !ids.includes(idT) && !ids.includes(idB),
    );
    r.ok(
      "P6 redo re-trashes T and B (rows gone, unmounted)",
      gone.ok && (await rendered(idT)) === 0 && (await rendered(idB)) === 0,
      JSON.stringify({
        ids: gone.value,
        t: await rendered(idT),
        b: await rendered(idB),
      }),
    );
    const bDocReTrashed = await docInit(idB, [{ text: "hidden child" }]);
    r.ok(
      "P6 redo: B's doc still readable, same bytes",
      bDocReTrashed === bDocOpened,
      JSON.stringify(docText(bDocReTrashed)),
    );
  }
  await undo();
  {
    const rows = await rowsSettle(
      (ids) => ids.includes(idT) && ids.includes(idB),
    );
    r.ok(
      "P6 undo: T and B back in server truth",
      rows.ok,
      JSON.stringify(rows.value),
    );
    // The restore keeps the STORED row (T expanded, from the PATCH above), and
    // the undo entry's `create` carries T as it was RECORDED (collapsed, at the
    // first delete). Both facts are asserted separately so the verdict says
    // which side is wrong when the screen and the server disagree.
    const all = await fetchRows(pageId);
    const t = all.find((row) => row.id === idT);
    r.ok(
      "P6 undo: server truth has T expanded (stored row wins over the recorded create)",
      t?.expanded === true,
      JSON.stringify({ tExpanded: t?.expanded }),
    );
    const shown = await waitFor(
      async () => ((await rendered(idB)) ? await textOf(idB) : null),
      (text) => text === B_DOC_TEXT,
    );
    r.ok(
      "P6 undo: B renders the doc's text again (client converged on server truth)",
      shown.ok,
      JSON.stringify({ b: shown.value, tRendered: await rendered(idT) }),
    );
    if (!shown.ok) {
      // Isolate the divergence: a reload renders server truth with no overlay.
      await pageA.goto(pageUrl, {
        waitUntil: "domcontentloaded",
        timeout: ELEMENT_TIMEOUT_MS,
      });
      await editorOf(idT).waitFor({
        state: "visible",
        timeout: ELEMENT_TIMEOUT_MS,
      });
      const afterReload = await waitFor(
        async () => ((await rendered(idB)) ? await textOf(idB) : null),
        (text) => text === B_DOC_TEXT,
      );
      r.ok(
        "P6 after reload: B renders the doc's text (the pre-reload client was stale, not the server)",
        afterReload.ok,
        JSON.stringify(afterReload.value),
      );
    }
  }
  await pageA.waitForTimeout(PROJECTION_MS);
  r.ok(
    "P6 B's doc bytes identical after redo + undo",
    (await fetchDocState(pageId, idB)) === bDocOpened,
  );
  r.ok(
    "P6 A untouched throughout",
    (await rendered(idA)) === 1 &&
      (await textOf(idA)) === "bold plain" &&
      (await fetchDocState(pageId, idA)) === aDocBefore,
  );
  await snap(pageA, out, "6-final");

  console.log("BLOCK_A:", idA);
  console.log("BLOCK_K:", idK);
  console.log("BLOCK_T:", idT);
  console.log("BLOCK_B:", idB);
  console.log("PAGE_ID:", pageId);
  console.log("PAGE_URL:", pageUrl);

  await r.finish();
});
