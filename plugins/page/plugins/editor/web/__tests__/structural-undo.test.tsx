// The per-mutation "is it recorded" invariant.
//
// Every mutation reachable from `useBlockEditor()` must put exactly ONE entry on
// the unified undo stack — except the two deliberate exclusions (`setExpanded`,
// `projectText`). There is no third case: no structural mutation is left
// unrecorded, so a new one that records nothing has no precedent to hide behind.
// This file is the guardrail: adding a mutation without recording it, or letting
// an existing one silently stop mutating, fails here. Both halves are real
// regressions this suite was written against — `paste` reached the store without
// ever passing `dispatchOp`, and `update` was swallowed whole by a data-blind
// apply-guard while every "canUndo flipped" style assertion stayed green.
//
// ## The invariant is a QUADRUPLE, not a pair
//
// "canUndo flipped and undo restored the rows" passes VACUOUSLY when the forward
// mutation did nothing at all — which is exactly how the `update` bug hid. So
// `expectRecorded` also asserts the forward mutation genuinely changed the row
// set, and that redo reproduces it.
//
// ## Fidelity caveats
//
// - The harness mounts the PROVIDER only, with a `RowsProbe` standing in for
//   `BlockEditorInner`. That stand-in is load-bearing, not scaffolding: `rowsRef`
//   — which every mutation snapshots as its `before` — is populated by a CONSUMER
//   effect (`block-editor.tsx`'s `setRows`/`setFlatOrder`). Without a stand-in
//   mirroring the same derivation, every mutation here reads an EMPTY `rowsRef`,
//   no-ops, and the whole suite passes vacuously. Same reason
//   `block-selection.test.tsx` keeps a `FakeBlockEditor`. Rendering the real
//   `<BlockEditor>` instead would need every block type registered plus Lexical
//   and a Yjs binding per row in a layout-less DOM.
// - The plugin list carries ONE handle, the seeded text type: block handles
//   supply `anchorTypes`, `wrapOnConvert` (neither exercised here) and
//   `textBearingTypes`, which the merge cases need — see `textHandle`.
// - `merge`/`mergeNext` run with no mounted focus handle, so `mergeBlock` takes
//   the OFFSCREEN branch: one `spliceStoredBlockDoc` against the two doc
//   endpoints, answered by the fake fetcher the harness's transport carries
//   (`withTransport(docServer)`), with a stored doc that holds the target's row
//   text. Undo/redo then replay the entry's runs edit onto the ROW (memory mode
//   with no live owner — `applyBlockRuns`' last arm), which is what lets the
//   quadruple compare row snapshots. Merge into a MOUNTED target, and split
//   with a live doc, are `text-undo-entries.test.tsx`'s.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useMemo } from "react";
import { encodeStateAsUpdate } from "yjs";

import {
  fakeFetchEndpoint,
  withTransport,
  type FakeFetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web/testing";
import {
  blockDocInit,
  blockDocUpdate,
} from "@plugins/page/plugins/editor-collab/core";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { UndoRedoProvider } from "@plugins/primitives/plugins/undo-redo/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  defineBlock,
  planForestInsert,
  runsOf,
  runsToXmlText,
  textBlockSchema,
  withMintedIds,
  type Block,
  type RichText,
  type SerializedBlock,
} from "../../core";
import { Editor } from "../slots";
import { CollabSession } from "../internal/collab-session";
import { blockDocsFor } from "../internal/use-block-docs";
import {
  projectableRunsOf,
  type DocSourcedRuns,
} from "../internal/doc-sourced-runs";
import { fromNodes } from "../internal/optimistic-block-ops";
import { BlockEditorProvider, useBlockEditor } from "../block-editor-context";

const PAGE_ID = "page-1";
const TEXT = "page/text";

// The text-bearing handle for the seeded type. Registered so the reducer's
// `BlockOpContext.textBearingTypes` names it: with an EMPTY registry that set
// is empty and `applyMerge` refuses every merge (its target "cannot hold
// text"), which would make the merge cases here pass vacuously as refused
// no-ops. Nothing mounts it — the harness renders only `RowsProbe`.
const textHandle = defineBlock({
  type: TEXT,
  schema: textBlockSchema({}),
  label: "Fixture text",
  empty: () => ({ text: [] }),
  // The plain paragraph, so `splice` can absorb a leading one into its origin
  // (`BlockOpContext.defaultTextType`) — the case every real paste takes.
  defaultText: true,
});
const plugins = [
  {
    id: "undo-fixture",
    description: "the text block type, for the reducer's context",
    contributions: [
      Editor.Block({ id: `${TEXT}-block`, match: TEXT, block: textHandle }),
    ],
  } as unknown as LoadedPlugin,
];

// Readable, reproducible ids: `withMintedIds` and every `newId` site mint
// through `crypto.randomUUID`, so a counter makes a failure's row set legible.
let uuidCounter = 0;
Object.defineProperty(globalThis.crypto, "randomUUID", {
  value: () => `id-${++uuidCounter}`,
  configurable: true,
  writable: true,
});

// The editor's transport for each case: its fetcher answers the offscreen
// merge's two doc endpoints (`fakeDocServer`).
let docServer: FakeFetchEndpoint;
beforeEach(() => {
  uuidCounter = 0;
  docServer = fakeDocServer();
});

// Content owners a case started (`Harness.own`). Ended after every case: the
// owner registry is module-level and keyed by block id, and ids restart at
// `id-1` per case, so a leaked owner would be another case's block.
const sessions: CollabSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.end();
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
  cleanup();
});

/**
 * The offscreen merge's two endpoints, stubbed: doc-init answers with a stored
 * doc holding the same text the TARGET row holds (`"B"`, the target every merge
 * case here resolves to — first-writer-wins, so the row's own proposal is
 * ignored), doc-update accepts the delta. Row text and stored text agreeing is
 * what makes the replay's row write (memory mode, no owner) reproduce exactly
 * the rows the patch pair restores.
 */
function fakeDocServer(): FakeFetchEndpoint {
  const stored = encodeStateAsUpdate(runsToXmlText([{ text: "B" }]).doc!);
  let bin = "";
  for (const byte of stored) bin += String.fromCharCode(byte);
  const state = btoa(bin);
  return fakeFetchEndpoint(({ endpoint }) => {
    if (endpoint === blockDocInit) return { state };
    if (endpoint === blockDocUpdate) return undefined;
    throw new Error("unexpected endpoint");
  });
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function node(text: string, children: SerializedBlock[] = []): SerializedBlock {
  return { type: TEXT, data: { text: [{ text }] }, expanded: true, children };
}

/**
 * `A ⊃ A1`, then `B`, `C` at top level — seeded through `MemoryBlockEditor`'s own
 * recipe, so the rows are shape-identical to production's. DEPTH is deliberate: a
 * flat fixture lets a same-parent rank sort masquerade as document order, which
 * is precisely the confusion `planBulkMove`'s `inDocumentOrder` exists to prevent.
 */
function seed(): Block[] {
  const forest = [node("A", [node("A1")]), node("B"), node("C")];
  const { nodes } = planForestInsert({
    pageId: PAGE_ID,
    parentId: PAGE_ID,
    rootRanks: Rank.nBetween(null, null, forest.length),
    forest: withMintedIds(forest),
  });
  return fromNodes(nodes, []);
}

/**
 * `runs` as the projection would actually produce them: round-tripped THROUGH a
 * content `Y.Doc`, since `projectText` only accepts doc-sourced runs (the
 * `DocSourcedRuns` brand — see `internal/doc-sourced-runs.ts`). A cast here
 * would defeat the very invariant the brand exists to state.
 */
function docRuns(runs: RichText): DocSourcedRuns {
  const doc = runsToXmlText(runs).doc;
  if (!doc) throw new Error("docRuns: seed XmlText is not attached to a doc");
  return projectableRunsOf(doc);
}

/** The seed bytes a content owner would be handed for `runs` (memory transport). */
function seedBytesFor(runs: RichText): () => Uint8Array {
  return () => {
    const doc = runsToXmlText(runs).doc;
    if (!doc)
      throw new Error("seedBytesFor: seed XmlText is not attached to a doc");
    return encodeStateAsUpdate(doc);
  };
}

/** The comparable projection of a row set — order-free (rows are keyed by id). */
function snapshot(blocks: Block[]) {
  return [...blocks]
    .map((b) => ({
      id: b.id,
      parentId: b.parentId,
      type: b.type,
      rank: String(b.rank),
      expanded: b.expanded,
      data: b.data,
    }))
    .sort((x, y) => x.id.localeCompare(y.id));
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Ctx = ReturnType<typeof useBlockEditor>;

/**
 * Stands in for `BlockEditorInner` — see the fidelity note in the file header.
 * The derivation is byte-for-byte what the real consumer feeds the provider.
 * `flatOrder` gets the same rank-sorted array: nothing this suite exercises reads
 * it (only `navigate` does), so an honest same-source feed beats re-implementing
 * `flattenTree` here.
 */
function RowsProbe({ onCtx }: { onCtx: (ctx: Ctx) => void }) {
  const ctx = useBlockEditor();
  // Published through a CALLBACK, not by writing a mutable prop: a prop object is
  // not this component's to modify (`react-hooks/immutability`), and the compiler
  // is right — the write belongs to `mount`'s closure, which owns the sink.
  //
  // No dep array on purpose: publish the context after EVERY commit, so a render
  // caused by nothing but `canUndo` flipping still updates the sink.
  useEffect(() => {
    onCtx(ctx);
  });

  const { blocks, setRows, setFlatOrder } = ctx;
  const rows = useMemo(
    () => [...blocks].sort((a, b) => Rank.compare(a.rank, b.rank)),
    [blocks],
  );
  useEffect(() => {
    setFlatOrder(rows);
    setRows(rows);
  }, [rows, setRows, setFlatOrder]);

  return null;
}

interface Harness {
  /** Always the LATEST committed context value. */
  ctx: () => Ctx;
  /** The seeded block id whose text is `text`. */
  id: (text: string) => string;
  /**
   * Give the seeded block `text` a live content owner holding that text — what
   * a mounted editor gives the block the caret is in. For the mutations that
   * edit the LIVE doc (a splice cuts its origin's), which refuse loudly without
   * one. Memory transport, so the seed IS the doc and the owner is
   * authoritative at once.
   */
  own: (text: string) => Promise<CollabSession>;
}

function mount(): Harness {
  const sink: { ctx: Ctx | null } = { ctx: null };
  const initialBlocks = seed();
  render(
    <PluginProvider plugins={plugins}>
      <UndoRedoProvider>
        <BlockEditorProvider
          pageId={PAGE_ID}
          persist={false}
          initialBlocks={initialBlocks}
        >
          <RowsProbe
            onCtx={(next) => {
              sink.ctx = next;
            }}
          />
        </BlockEditorProvider>
      </UndoRedoProvider>
    </PluginProvider>,
    { wrapper: withTransport(docServer) },
  );
  const ctx = () => {
    if (!sink.ctx) throw new Error("provider never rendered its child");
    return sink.ctx;
  };
  const byText = new Map(
    initialBlocks.map((b) => {
      const runs = (b.data as { text: { text: string }[] }).text;
      return [runs[0]!.text, b.id] as const;
    }),
  );
  const id = (text: string): string => {
    const found = byText.get(text);
    if (!found) throw new Error(`no seeded block with text "${text}"`);
    return found;
  };
  return {
    ctx,
    id,
    own: async (text) => {
      const session = CollabSession.start(
        blockDocsFor(docServer.transport),
        id(text),
        seedBytesFor([{ text }]),
        "present",
        false,
      );
      sessions.push(session);
      await session.owner.provider.connect();
      return session;
    },
  };
}

/**
 * Let everything a mutation or a replay deferred land: the offscreen merge
 * dispatches after its (stubbed) endpoint round trip, a replay dispatches its
 * patch after `await applyBlockRuns`, and `act` alone does not wait past the
 * callback's own promise. One macrotask drains every microtask chain in flight.
 */
const settle = () =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

/**
 * The whole invariant, in one place, so a new mutation is a one-line addition.
 * Everything is driven through `await act(async …)` plus a settle: `undo`/`redo`
 * run their thunks as floating promises and `split` defers its record a
 * microtask.
 */
async function expectRecorded(
  run: (h: Harness) => void | Promise<void>,
): Promise<void> {
  const h = mount();
  const before = snapshot(h.ctx().blocks);
  expect(h.ctx().canUndo).toBe(false);

  await act(async () => run(h));
  await settle();
  const after = snapshot(h.ctx().blocks);

  // (1) The forward mutation actually changed the document. Without this the
  //     rest of the quadruple is satisfiable by a mutation that does nothing.
  expect(after).not.toEqual(before);
  // (2) …and put an entry on the stack.
  expect(h.ctx().canUndo).toBe(true);

  // (3) Undo restores the prior row set EXACTLY.
  await act(async () => h.ctx().undo());
  await settle();
  expect(snapshot(h.ctx().blocks)).toEqual(before);

  // (4) Redo reproduces the post-mutation row set.
  await act(async () => h.ctx().redo());
  await settle();
  expect(snapshot(h.ctx().blocks)).toEqual(after);
}

// ---------------------------------------------------------------------------
// Recorded mutations
// ---------------------------------------------------------------------------

const RECORDED: [name: string, run: (h: Harness) => void | Promise<void>][] = [
  ["paste", (h) => h.ctx().paste({ blocks: [node("P")], afterId: h.id("B") })],
  [
    // A leading paragraph absorbed into the origin AND a block below it: the
    // structural patch and the origin's doc edit are ONE entry, so undo takes
    // the heading away and the `x` off `B` together.
    "splice",
    async (h) => {
      await h.own("B");
      h.ctx().splice({
        blockId: h.id("B"),
        position: 1,
        runs: [{ text: "B" }],
        blocks: [node("x"), { ...node("H"), type: "page/heading-1" }],
        granularity: "text",
      });
    },
  ],
  [
    // Whole blocks (a copied block): no merge, the copy lands after the line.
    "splice (whole blocks)",
    async (h) => {
      await h.own("B");
      h.ctx().splice({
        blockId: h.id("B"),
        position: 1,
        runs: [{ text: "B" }],
        blocks: [node("copy")],
        granularity: "blocks",
      });
    },
  ],
  [
    // TWO roots on purpose: one gesture is ONE `duplicate` op however many roots
    // it clones, so a per-root dispatch (N entries, N undos) fails the quadruple
    // — undo would restore only the last clone's placement.
    "bulkDuplicate",
    (h) => h.ctx().bulkDuplicate([h.id("A"), h.id("C")]),
  ],
  [
    "bulkMove",
    (h) =>
      h.ctx().bulkMove({
        ids: [h.id("C")],
        parentId: h.id("A"),
        afterId: h.id("A1"),
      }),
  ],
  ["bulkDelete", (h) => h.ctx().bulkDelete([h.id("B")])],
  ["move", (h) => h.ctx().move(h.id("C"), "before", h.id("B"))],
  ["indentBlocks", (h) => h.ctx().indentBlocks([h.id("C")])],
  ["outdentBlocks", (h) => h.ctx().outdentBlocks([h.id("A1")])],
  ["insert", (h) => h.ctx().insert(TEXT, { text: [] })],
  ["insertFirst", (h) => h.ctx().insertFirst(TEXT, { text: [] })],
  ["unwrapBlock", (h) => h.ctx().unwrapBlock(h.id("A"))],
  // Both payloads are text-FREE, and not merely by choice: `RowData` makes a
  // row-level `text` write a compile error, because `page_blocks.data.text` is a
  // projection of the block's content `Y.Doc` with exactly one writer. So the
  // mutation each case has to make is the row fact it really owns — the TYPE for
  // `convertTo`, a non-text `data` field for `update` — which is also what makes
  // the quadruple's "the forward mutation genuinely changed something" arm honest
  // here rather than incidental.
  [
    "convertTo",
    (h) => h.ctx().makeBlockAPI(h.id("B")).convertTo("page/heading-1", {}),
  ],
  ["update", (h) => h.ctx().makeBlockAPI(h.id("B")).update({ checked: true })],
  [
    // Enter at offset 0 of a non-empty block: the identity-preserving arm, which
    // records a PLAIN structural entry (no content-doc edit to fold in).
    "split at offset 0",
    (h) =>
      h
        .ctx()
        .makeBlockAPI(h.id("B"))
        .split(0, { runs: [{ text: "B" }] }),
  ],
  [
    // Backspace at the start of C merges it up into B (its previous visible
    // line). B has no mounted editor here, so the append goes to the stored
    // doc (stubbed) and the entry carries it as a runs edit on B.
    "merge (offscreen target)",
    (h) =>
      h
        .ctx()
        .makeBlockAPI(h.id("C"))
        .merge({ runs: [{ text: "C" }] }),
  ],
  [
    // Delete at the end of B pulls C up into B — the same merge from the
    // other originating block.
    "mergeNext (offscreen target)",
    (h) => h.ctx().makeBlockAPI(h.id("B")).mergeNext(),
  ],
];

describe("every editor mutation lands exactly one undo entry", () => {
  for (const [name, run] of RECORDED) {
    it(name, async () => {
      await expectRecorded(run);
    });
  }
});

describe("splice edits its origin's DOC inside the same entry", () => {
  const docText = (session: CollabSession): string =>
    session.owner
      .runsNow()
      .map((r) => r.text)
      .join("");

  it("one undo restores the origin's text and removes the pasted rows; redo re-applies both", async () => {
    const h = mount();
    const session = await h.own("B");
    const before = snapshot(h.ctx().blocks);
    await act(async () =>
      h.ctx().splice({
        blockId: h.id("B"),
        position: 1,
        runs: [{ text: "B" }],
        blocks: [node("x"), node("y")],
        granularity: "text",
      }),
    );
    await settle();
    // `B|` + `x⏎y`: the head joins the origin's line, the rest is a new row.
    expect(docText(session)).toBe("Bx");
    const after = snapshot(h.ctx().blocks);
    expect(after.length).toBe(before.length + 1);

    await act(async () => h.ctx().undo());
    await settle();
    expect(docText(session)).toBe("B");
    expect(snapshot(h.ctx().blocks)).toEqual(before);
    expect(h.ctx().canUndo).toBe(false);

    await act(async () => h.ctx().redo());
    await settle();
    expect(docText(session)).toBe("Bx");
    expect(snapshot(h.ctx().blocks)).toEqual(after);
  });

  it("a single-paragraph splice creates no row: it is one text entry", async () => {
    const h = mount();
    const session = await h.own("B");
    const before = snapshot(h.ctx().blocks);
    await act(async () =>
      h.ctx().splice({
        blockId: h.id("B"),
        position: 0,
        runs: [{ text: "B" }],
        blocks: [node("pasted ")],
        granularity: "text",
      }),
    );
    await settle();
    expect(docText(session)).toBe("pasted B");
    // Rows are untouched (the row's text follows through the projection).
    expect(snapshot(h.ctx().blocks)).toEqual(before);
    expect(h.ctx().canUndo).toBe(true);

    await act(async () => h.ctx().undo());
    await settle();
    expect(docText(session)).toBe("B");
    expect(h.ctx().canUndo).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The deliberate non-recordings
// ---------------------------------------------------------------------------

describe("mutations that deliberately stay off the stack", () => {
  it("setExpanded changes the rows but records nothing (pure view state)", async () => {
    const h = mount();
    const before = snapshot(h.ctx().blocks);
    await act(async () => h.ctx().makeBlockAPI(h.id("A")).setExpanded(false));
    // Still optimistic — it just isn't a document edit.
    expect(snapshot(h.ctx().blocks)).not.toEqual(before);
    expect(h.ctx().canUndo).toBe(false);
  });

  it("projectText changes the rows but records nothing (Yjs owns text history)", async () => {
    const h = mount();
    const before = snapshot(h.ctx().blocks);
    await act(async () =>
      h.ctx().projectText(h.id("B"), docRuns([{ text: "typed" }])),
    );
    expect(snapshot(h.ctx().blocks)).not.toEqual(before);
    expect(h.ctx().canUndo).toBe(false);
  });

  it("a fully-refused indent records nothing and changes nothing", async () => {
    const h = mount();
    const before = snapshot(h.ctx().blocks);
    // `A` is the first top-level block: it has no previous sibling to nest under,
    // so `foldIndent` refuses the whole run and `dispatchOp` drops the empty diff
    // before it can reach the stack or the network.
    await act(async () => h.ctx().indentBlocks([h.id("A")]));
    expect(snapshot(h.ctx().blocks)).toEqual(before);
    expect(h.ctx().canUndo).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The reverse patch pins a removed row's text to its DOC, not its lagged row
// ---------------------------------------------------------------------------

describe("undo of a delete restores the row with its content doc's runs", () => {
  it("pins the recreated row's data.text to the live owner's runsNow(), not the ~1 s-lagged projection", async () => {
    const h = mount();
    const id = h.id("B");
    // A live content owner for B whose doc holds MORE than the row does: the
    // `data.text` projection is debounced ~1 s, so at delete time the row still
    // says "B" while the doc already says "B typed". Memory transport, so the
    // seed IS the doc's whole content and the owner is authoritative at once.
    const session = CollabSession.start(
      blockDocsFor(docServer.transport),
      id,
      seedBytesFor([{ text: "B typed" }]),
      "present",
      false,
    );
    await session.owner.provider.connect();
    const live = session.owner.runsNow();
    const rowText = (row: Block | undefined): string =>
      runsOf((row?.data as { text?: unknown } | null)?.text)
        .map((r) => r.text)
        .join("");
    expect(live.map((r) => r.text).join("")).toBe("B typed");
    expect(rowText(h.ctx().blocks.find((b) => b.id === id))).toBe("B");

    await act(async () => h.ctx().bulkDelete([id]));
    expect(h.ctx().blocks.some((b) => b.id === id)).toBe(false);
    await act(async () => h.ctx().undo());

    // The row is back under its original id, carrying what the DOC held — the
    // value the projection would have written had it flushed, and the seed of
    // the block's doc wherever that doc did not survive.
    const restored = h.ctx().blocks.find((b) => b.id === id);
    expect(restored).toBeDefined();
    expect(rowText(restored)).toBe("B typed");
    expect(runsOf((restored?.data as { text?: unknown }).text)).toEqual(live);

    session.end();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    });
  });
});
