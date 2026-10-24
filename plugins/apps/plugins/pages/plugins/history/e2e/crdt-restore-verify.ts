// History restore keeps block identity — verified end to end on a deployed build
// (research/2026-09-11-page-history-restore-preserves-block-identity.md §8).
//
// A restore matches the version's blocks to the page's BY ID: a block both have
// keeps its id and has its content doc EDITED to the version's text; a block
// deleted since comes back from the trash as itself; a block created since is
// trashed. Nothing is hard-deleted, so restoring the "Before restore" version
// undoes a restore the same way.
//
// Phases:
//  1. create a page with two blocks, A ("version one…") and B ("block two");
//     wait for the v1 snapshot (4 s debounce); keep B's stored doc bytes;
//  2. since v1: append to A, add a new block N below it, and delete B — then
//     restore BEFORE the next snapshot fires (versions coalesce inside a
//     ~10 min window, so a later snapshot would overwrite v1). Keep A's and N's
//     stored docs, and mark A's editable DOM node;
//  3. restore v1 with the editor OPEN (the call the Version-history dialog
//     makes);
//  4. the open editor shows v1 — A then B — and A's editable is the SAME DOM
//     node (it was never remounted);
//  5. rows: A keeps its id and reads v1; B is back under its own id; N is gone;
//  6. A's SAME doc row reads v1 and still holds every item the browser typed
//     (the doc was edited, not replaced);
//  7. B's doc holds its original items and its original text;
//  8. N is trashed, and its doc row survives byte-identical;
//  9. the open editor is live on A's doc: typing syncs; a second context
//     converges;
// 10. a stale projection UPDATE for N (computed before the restore, arriving
//     after it) does not resurrect N — an update never creates;
// 11. restore "Before restore": N comes back under its own id with doc bytes
//     identical to before the first restore, and B is trashed again.
//
// Usage: ./equin run plugins/apps/plugins/pages/plugins/history/e2e/crdt-restore-verify.ts [--url <deploy>] [--out <path>]
import {
  agentFetch,
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  blockDocStateVector,
  blockDocText,
  fetchBlockDoc,
  fetchBlockDocText,
  stateVectorCovers,
} from "@plugins/page/plugins/editor-collab/e2e";
import {
  blockIdOf,
  blockText,
  editableBlocks,
  openBlankPage,
} from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/crdt-restore");

interface TextRun {
  text?: string;
}
interface BlockRow {
  id: string;
  type: string;
  parentId: string | null;
  rank: string;
  data?: { text?: TextRun[] };
}
interface VersionRow {
  id: string;
  label: string | null;
  pinned: boolean;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`GET ${url}: HTTP ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

const fetchBlocks = (pageId: string): Promise<BlockRow[]> =>
  fetchJson<BlockRow[]>(pathUrl(`/api/pages/${pageId}/blocks`));

/** Versions of the page, newest first. */
const fetchVersions = (pageId: string): Promise<VersionRow[]> =>
  fetchJson<VersionRow[]>(pathUrl(`/api/history/pages/${pageId}/versions`));

const rowText = (row: BlockRow | undefined): string =>
  (row?.data?.text ?? []).map((run) => run.text ?? "").join("");

/** The stored doc state of a block, or a loud failure when it has none. */
async function docState(blockId: string): Promise<string> {
  const doc = await fetchBlockDoc(blockId);
  if (!doc) throw new Error(`block ${blockId} has no page_block_docs row`);
  return doc.state;
}

async function restoreVersion(pageId: string, versionId: string) {
  return agentFetch(
    `/api/history/pages/${pageId}/versions/${versionId}/restore`,
    { method: "POST" },
  );
}

const V1 = "version one alpha content";
const V2_SUFFIX = " EDITED-second-version";
const B_TEXT = "block two";
const N_TEXT = "post-v1 block";

/** Window property the DOM-identity probe parks A's editable on. */
const PROBE = "__restoreIdentityProbe";

await withBrowser(async (h) => {
  const r = report();
  const { page: pageA } = await h.session({ label: "A" });

  // --- 1. v1: two blocks ------------------------------------------------------
  const {
    pageUrl,
    pageId,
    block,
    blockId: idA,
  } = await openBlankPage(pageA, { settleMs: 3000 });
  console.log("pageId:", pageId);

  await pageA.keyboard.type(V1, { delay: 10 });
  await pageA.keyboard.press("Enter");
  await pageA.keyboard.type(B_TEXT, { delay: 10 });
  // Snapshot debounce is 4s after the last blocksChanged; wait for the v1 snapshot.
  await pageA.waitForTimeout(8000);

  const versionsAfterV1 = await fetchVersions(pageId);
  r.ok(
    "v1 snapshot recorded",
    versionsAfterV1.length >= 1,
    `versions=${versionsAfterV1.length}`,
  );
  const idB = await blockIdOf(editableBlocks(pageA).nth(1));
  const bDocBeforeDelete = await docState(idB);
  r.ok(
    "B's stored doc reads its text before the delete",
    blockDocText(bDocBeforeDelete).trim() === B_TEXT,
    blockDocText(bDocBeforeDelete),
  );

  // --- 2. since v1: edit A, add N, delete B -------------------------------------
  const postPatch = (body: unknown) =>
    agentFetch(`/api/pages/${pageId}/blocks/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  await block.click();
  await pageA.keyboard.press("End");
  await pageA.keyboard.type(V2_SUFFIX, { delay: 10 });
  await pageA.keyboard.press("Enter");
  await pageA.keyboard.type(N_TEXT, { delay: 10 });
  const idN = await blockIdOf(editableBlocks(pageA).nth(1));
  const deleteRes = await postPatch({
    creates: [],
    updates: [],
    deleteIds: [idB],
  });
  r.ok("B deleted (2xx)", deleteRes.ok, `status=${deleteRes.status}`);
  // > projection debounce (1s), < snapshot debounce (4s).
  await pageA.waitForTimeout(1800);

  const versions = await fetchVersions(pageId);
  const v1Version = versions[versions.length - 1];
  const preRows = await fetchBlocks(pageId);
  r.ok(
    "live rows hold v2 before the restore",
    rowText(preRows.find((row) => row.id === idA)) === V1 + V2_SUFFIX &&
      rowText(preRows.find((row) => row.id === idN)) === N_TEXT &&
      !preRows.some((row) => row.id === idB),
    JSON.stringify(preRows.map((row) => [row.id, rowText(row)])),
  );
  const aDocBeforeRestore = await docState(idA);
  const nDocBeforeRestore = await docState(idN);

  // Park A's editable DOM node on `window`: after the restore it must still be
  // the node the document renders for A — the editor never remounted it.
  await editableBlocks(pageA)
    .first()
    .evaluate((el, key) => {
      (window as unknown as Record<string, Element>)[key] = el;
    }, PROBE);

  // --- 3. restore v1 with the editor open -----------------------------------
  if (!v1Version)
    throw new Error("no history version recorded — nothing to restore");
  const res = await restoreVersion(pageId, v1Version.id);
  r.ok("restore endpoint 2xx", res.ok, `status=${res.status}`);

  // Let the pushes land, the text phase's doc merge apply, projection settle.
  await pageA.waitForTimeout(4000);
  await snap(pageA, out, "restored");

  // --- 4. the open editor shows v1, without remounting A ----------------------
  const domTexts = await Promise.all(
    (await editableBlocks(pageA).all()).map(blockText),
  );
  r.ok(
    "open editor shows v1 (A, then B)",
    JSON.stringify(domTexts) === JSON.stringify([V1, B_TEXT]),
    JSON.stringify(domTexts),
  );
  const sameNode = await pageA.evaluate(
    ({ key, id }) => {
      const probe = (window as unknown as Record<string, Element | undefined>)[
        key
      ];
      const now = document.querySelector(
        `[data-block-id="${id}"] [contenteditable="true"]`,
      );
      return probe !== undefined && probe.isConnected && probe === now;
    },
    { key: PROBE, id: idA },
  );
  r.ok("A's editable is the same DOM node across the restore", sameNode);

  // --- 5. rows: ids kept, B back, N gone ------------------------------------
  const rows = await fetchBlocks(pageId);
  const contentRows = rows.filter((row) => row.type !== "page");
  r.ok(
    "the restored rows are exactly A and B, under their own ids",
    JSON.stringify(contentRows.map((row) => row.id).sort()) ===
      JSON.stringify([idA, idB].sort()),
    JSON.stringify(contentRows.map((row) => row.id)),
  );
  r.ok(
    "A's row reads v1",
    rowText(rows.find((row) => row.id === idA)) === V1,
    JSON.stringify(rowText(rows.find((row) => row.id === idA))),
  );
  r.ok(
    "B's row reads its text",
    rowText(rows.find((row) => row.id === idB)) === B_TEXT,
  );
  r.ok("N is gone from the page", !rows.some((row) => row.id === idN));

  // --- 6. A's doc was edited, not replaced -----------------------------------
  const aDocAfter = await docState(idA);
  r.ok(
    "A's doc row reads v1",
    blockDocText(aDocAfter).trim() === V1,
    blockDocText(aDocAfter),
  );
  r.ok(
    "A's doc still holds every item it held before the restore (it grew)",
    stateVectorCovers(
      blockDocStateVector(aDocAfter),
      blockDocStateVector(aDocBeforeRestore),
    ),
  );

  // --- 7. B came back with its own doc ---------------------------------------
  const bDocAfter = await docState(idB);
  r.ok(
    "B's doc holds its original items",
    stateVectorCovers(
      blockDocStateVector(bDocAfter),
      blockDocStateVector(bDocBeforeDelete),
    ),
  );
  r.ok(
    "B's doc reads its original text",
    blockDocText(bDocAfter).trim() === B_TEXT,
    blockDocText(bDocAfter),
  );

  // --- 8. N is trashed, its doc intact ---------------------------------------
  const nDocTrashed = await fetchBlockDoc(idN);
  r.ok(
    "N's doc row survives the restore, byte-identical",
    nDocTrashed?.state === nDocBeforeRestore,
  );

  // --- 9. the editor is live; a second context converges ----------------------
  await editableBlocks(pageA).first().click();
  await pageA.keyboard.press("End");
  await pageA.keyboard.type(" post-restore", { delay: 15 });
  await pageA.waitForTimeout(2500);
  const syncedText = await fetchBlockDocText(idA);
  r.ok(
    "post-restore typing into A syncs",
    syncedText.trim() === `${V1} post-restore`,
    syncedText,
  );

  const { page: pageB } = await h.session({ label: "B" });
  await pageB.goto(pageUrl);
  await pageB.waitForTimeout(5000);
  const bTexts = await Promise.all(
    (await editableBlocks(pageB).all()).map(blockText),
  );
  r.ok(
    "context B converges",
    JSON.stringify(bTexts) === JSON.stringify([`${V1} post-restore`, B_TEXT]),
    JSON.stringify(bTexts),
  );
  await snap(pageB, out, "context-b");

  // --- 10. a stale projection does not resurrect N ----------------------------
  // A projection flush computed before the restore arrives after it (the
  // client gate cannot cover requests already in flight). A projection changes
  // only `data`, so it is an UPDATE — and an update never creates, so the
  // trashed row is skipped. No flag: the patch's shape is the guarantee.
  const patchRes = await postPatch({
    creates: [],
    updates: [{ id: idN, changes: { data: { text: [{ text: "ZOMBIE" }] } } }],
    deleteIds: [],
  });
  r.ok(
    "stale projection update accepted (2xx)",
    patchRes.ok,
    `status=${patchRes.status}`,
  );
  const rowsAfterPatch = await fetchBlocks(pageId);
  r.ok(
    "stale projection did NOT resurrect N",
    !rowsAfterPatch.some((row) => row.id === idN),
  );
  r.ok(
    "N's doc untouched by the stale patch",
    (await fetchBlockDoc(idN))?.state === nDocBeforeRestore,
  );

  // --- 11. restoring "Before restore" undoes the restore by identity ----------
  const beforeRestore = (await fetchVersions(pageId)).find(
    (v) => v.label === "Before restore",
  );
  if (!beforeRestore)
    throw new Error('no "Before restore" version was pinned by the restore');
  const undoRes = await restoreVersion(pageId, beforeRestore.id);
  r.ok("undo restore endpoint 2xx", undoRes.ok, `status=${undoRes.status}`);
  await pageA.waitForTimeout(4000);
  await snap(pageA, out, "before-restore-restored");

  const rowsUndone = await fetchBlocks(pageId);
  r.ok(
    "N is back under its own id",
    rowText(rowsUndone.find((row) => row.id === idN)) === N_TEXT,
    JSON.stringify(rowsUndone.map((row) => [row.id, rowText(row)])),
  );
  r.ok(
    "N's doc bytes are identical to before the first restore",
    (await docState(idN)) === nDocBeforeRestore,
  );
  r.ok("B is trashed again", !rowsUndone.some((row) => row.id === idB));
  r.ok(
    "A reads its pre-restore text again",
    rowText(rowsUndone.find((row) => row.id === idA)) === V1 + V2_SUFFIX,
    JSON.stringify(rowText(rowsUndone.find((row) => row.id === idA))),
  );

  await r.finish();
});
