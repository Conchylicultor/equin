// Stage-4a multi-tab + agent-concurrency verification (Task 3).
//
// With per-block CRDT text (now unconditional — the flag is deleted):
//  A. Multi-tab: two tabs in ONE browser context (shared leader-elected
//     live-state socket) edit the same page — different blocks and the SAME
//     block — and must converge, with exactly ONE /ws/notifications socket
//     across both tabs (no per-block socket explosion).
//  B. Agent concurrency: an out-of-band writer POSTs a raw Yjs update to
//     /api/blocks/:id/doc-update (prepending a marker) WHILE the user types in
//     that same block — the edits must MERGE (no lost text) and the user's
//     caret must stay at the end of what they're typing (no jump).
//
// Usage: bun plugins/page/plugins/editor-collab/e2e/crdt-multitab-agent-verify.ts [--url <deploy>] [--out <path>]
import type { Page } from "playwright";
import * as Y from "yjs";
import {
  agentFetch,
  arg,
  capture,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { waitFor } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";
import {
  blockText,
  caretState,
  editableBlocks,
  openBlankPage,
} from "@plugins/page/plugins/editor/e2e";
import { tapSharedSocket } from "@plugins/primitives/plugins/networking/e2e";
import { fetchBlockDoc } from "./support/ydoc";

const out = arg("out", "/tmp/crdt-multitab");

const r = report();

/** Every editable block's rendered text in one tab, in document order. */
const readAll = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "[data-block-id] [data-block-text]",
      ),
    ].map((el) => el.innerText),
  );

await withBrowser(async (h) => {
  const { context: ctx, page: tabA } = await h.session({ label: "A" });

  // Which live-state server connection each tab is bound to — through the
  // shared socket's tap (the socket lives in a SharedWorker, out of
  // `page.on("websocket")`'s reach).
  const WS = "/ws/notifications";
  const tapA = await tapSharedSocket(tabA);

  const {
    pageUrl,
    block: blockA,
    blockId: block1Id,
  } = await openBlankPage(tabA, { settleMs: 3000 });

  await tabA.keyboard.type("first block from tab A", { delay: 10 });
  // Second block for tab B to edit.
  await tabA.keyboard.press("Enter");
  await tabA.waitForTimeout(100);
  await tabA.keyboard.type("second block", { delay: 10 });
  await tabA.waitForTimeout(1500);

  // --- Second tab, SAME context (shares the SharedWorker's socket) -------------
  const tabB = await ctx.newPage();
  capture(tabB, "B");
  const tapB = await tapSharedSocket(tabB);
  await tabB.goto(pageUrl);
  // Was a fixed `waitForTimeout(4000)`. This one is worse than a bad read: tab B
  // goes on to CLICK AND TYPE into block 2, so if it has not hydrated the edit
  // lands in an empty editor and the failure surfaces further down as a
  // convergence mismatch that reads like a merge bug. Wait for the document tab
  // A authored to actually be on screen here.
  const blocksB = editableBlocks(tabB);
  const openedB = await waitFor(
    async () => (await readAll(tabB)).map((t) => t.replace(/ /g, " ").trim()),
    (texts) =>
      JSON.stringify(texts) ===
      JSON.stringify(["first block from tab A", "second block"]),
  );
  console.log(
    "tab B opened:",
    JSON.stringify(openedB.value),
    `(after ${openedB.waitedMs}ms, ${openedB.attempts} reads)`,
  );
  r.ok(
    "tab B rendered tab A's blocks before editing",
    openedB.ok,
    JSON.stringify(openedB.value),
  );

  // Tab B edits the SECOND block (different-block concurrency).
  const blockB2 = blocksB.nth(1);
  await blockB2.click();
  await tabB.keyboard.press("End");
  await tabB.keyboard.type(" +B", { delay: 15 });
  await tabB.waitForTimeout(1500);

  // Tab A edits the FIRST block concurrently-ish.
  await tabA.bringToFront();
  await blockA.click();
  await tabA.keyboard.press("End");
  await tabA.keyboard.type(" +A", { delay: 15 });
  await tabA.waitForTimeout(2000);

  const textsA = (await readAll(tabA)).map((t) => t.replace(/ /g, " ").trim());
  const textsB = (await readAll(tabB)).map((t) => t.replace(/ /g, " ").trim());
  const EXPECT = ["first block from tab A +A", "second block +B"];
  r.ok(
    "tab A converged (both blocks)",
    JSON.stringify(textsA) === JSON.stringify(EXPECT),
    JSON.stringify(textsA),
  );
  r.ok(
    "tab B converged (both blocks)",
    JSON.stringify(textsB) === JSON.stringify(EXPECT),
    JSON.stringify(textsB),
  );

  // SAME-block concurrency across tabs: both tabs type into block 1.
  await tabB.bringToFront();
  await blocksB.first().click();
  await tabB.keyboard.press("Home");
  await tabB.keyboard.type("[B]", { delay: 15 });
  await tabB.waitForTimeout(200);
  await tabA.bringToFront();
  await blockA.click();
  await tabA.keyboard.press("End");
  await tabA.keyboard.type(" [A-end]", { delay: 15 });
  await tabA.waitForTimeout(2500);
  const sameA = await blockText(blockA);
  const sameB = await blockText(blocksB.first());
  const SAME = "[B]first block from tab A +A [A-end]";
  r.ok(
    "same-block edits merged in tab A",
    sameA === SAME,
    JSON.stringify(sameA),
  );
  r.ok(
    "same-block edits merged in tab B",
    sameB === SAME,
    JSON.stringify(sameB),
  );

  // One shared notifications socket for the whole context (leader-elected).
  r.ok(
    "ONE shared /ws/notifications connection across both tabs",
    tapA.connections(WS).length === 1 &&
      JSON.stringify(tapA.connections(WS)) ===
        JSON.stringify(tapB.connections(WS)),
    JSON.stringify({ A: tapA.connections(WS), B: tapB.connections(WS) }),
  );
  await snap(tabA, out, "multitab");

  // --- B. Agent concurrency ------------------------------------------------------
  // Out-of-band writer: read the authoritative state, prepend a marker to the
  // first paragraph via raw Yjs, POST the incremental update — while tab A types
  // at the end of the same block.
  const marker = "[AGENT] ";
  const agentWrite = (async () => {
    const stored = await fetchBlockDoc(block1Id);
    if (!stored) throw new Error(`no page_block_docs row for ${block1Id}`);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Uint8Array.from(Buffer.from(stored.state, "base64")));
    const before = Y.encodeStateVector(doc);
    const root = doc.get("root", Y.XmlText);
    const firstPara = (root.toDelta() as { insert?: unknown }[])
      .map((op) => op.insert)
      .find((insert): insert is Y.XmlText => insert instanceof Y.XmlText);
    if (!firstPara) throw new Error("no paragraph in block doc");
    doc.transact(() => firstPara.insert(0, marker));
    // Copy into an ArrayBuffer-backed view: yjs types its output as
    // Uint8Array<ArrayBufferLike>, which BodyInit rejects (it could be shared).
    const update = new Uint8Array(Y.encodeStateAsUpdate(doc, before));
    const post = await agentFetch(`/api/blocks/${block1Id}/doc-update`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: update,
    });
    if (!post.ok) throw new Error(`doc-update failed: ${post.status}`);
  })();

  // Type WHILE the agent write is in flight and its echo lands.
  await tabA.keyboard.type(" typed-during-agent-write", { delay: 25 });
  await agentWrite;
  await tabA.waitForTimeout(2500);

  const FINAL = `${marker}${SAME} typed-during-agent-write`;
  const finalA = await blockText(blockA);
  const finalB = await blockText(blocksB.first());
  r.ok(
    "agent write + user typing merged (tab A)",
    finalA === FINAL,
    JSON.stringify(finalA),
  );
  r.ok(
    "tab B converged on the merge",
    finalB === FINAL,
    JSON.stringify(finalB),
  );

  // Caret: still collapsed at the very end of the typed text (no jump despite
  // the remote prepend shifting every offset).
  const caret = await caretState(blockA);
  r.ok(
    "caret pinned to the end of the user's text (no jump)",
    caret.hasSelection &&
      !!caret.insideBlock &&
      !!caret.collapsed &&
      caret.anchorOffset === caret.anchorTextLength,
    JSON.stringify(caret),
  );
  await snap(tabA, out, "agent");

  await r.finish();
});
