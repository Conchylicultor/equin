// Text undo entries are DATA, and every gesture that edits a content doc
// records exactly one of them.
//
// The incident this suite pins (`research/2026-09-09-page-data-based-text-undo-entries-v2.md`
// §1): type into a block, delete the block, Ctrl+Z, Ctrl+Z. The second Ctrl+Z
// used to be a SILENT no-op — the text entry was a thunk popping the block's
// per-doc undo manager, guarded by "is this owner still live", and the delete
// had destroyed the owner. An entry is now `{blockId, before, after}` runs and
// replays on whichever host holds the block at that moment: its open doc when
// an editor holds one, the row itself in memory mode with no owner. There is no
// arm that does nothing.
//
// The other claims, one per gesture:
//
// - a split records ONE entry carrying the structural patch AND the origin's
//   truncation, so one Ctrl+Z restores the origin's text and removes the tail
//   together (the forward truncation runs inside `untracked`, so the run
//   tracker does not also record it as typing — the double-entry hazard);
// - a merge into a MOUNTED target records one entry whose undo restores the
//   source row and un-appends the target;
// - `recordDocEdit` records exactly one entry and the tracker none;
// - a typing run sealed by the pending flush while another entry's replay is
//   still in flight still LANDS, and replays in turn.
//
// ## Fidelity
//
// Same harness as `structural-undo.test.tsx`: the PROVIDER only, in memory
// mode, with a `RowsProbe` standing in for `BlockEditorInner`. No Lexical is
// mounted; a block's "editor" is a `CollabSession` the test holds plus, where a
// gesture reaches for one, a registered focus handle whose surgery edits the
// owner's doc the way a relayed binding would — a local transaction under a
// binding-shaped origin (`applyAs`), which is exactly what the run tracker
// classifies as the user typing. The two content-doc hooks are not mounted, so
// the test subscribes to the owner's `onRunsEdit` itself and forwards to the
// context's `recordTextEdit`, as `collab-text-plugin` does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useMemo } from "react";
import * as Y from "yjs";
import { LinkNode } from "@lexical/link";

vi.mock("@plugins/infra/plugins/endpoints/web", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchEndpoint: vi.fn() };
});
vi.mock("@plugins/primitives/plugins/networking/web", () => ({
  subscribeWsStatus: () => () => {},
}));
vi.mock("@plugins/primitives/plugins/live-state/web", () => ({
  liveStateSocketKind: () => "worktree",
}));
vi.mock("@plugins/network/plugins/live/web", () => ({
  useLiveRow: vi.fn(() => ({
    status: "loading",
    refetch: () => Promise.resolve(),
  })),
}));

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { UndoRedoProvider } from "@plugins/primitives/plugins/undo-redo/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { editYDocState } from "@plugins/primitives/plugins/collab-doc/core";
import {
  $spliceRunsInto,
  defineBlock,
  mergeRuns,
  planForestInsert,
  runsOf,
  runsToXmlText,
  splitRuns,
  textBlockSchema,
  withMintedIds,
  type Block,
  type RichText,
  type SerializedBlock,
} from "../../core";
import { Editor } from "../slots";
import {
  blockDocOwnerOf,
  CollabSession,
  type BlockDocOwner,
} from "../internal/collab-session";
import { blockTextRunsOptions } from "../internal/block-text-extensions";
import { buildSeedStateFor } from "../internal/block-seed-state";
import {
  projectableRunsOf,
  type DocSourcedRuns,
} from "../internal/doc-sourced-runs";
import type { BlockRunsEdit } from "../internal/block-run-tracker";
import { fromNodes } from "../internal/optimistic-block-ops";
import { BlockEditorProvider, useBlockEditor } from "../block-editor-context";

const PAGE_ID = "page-1";
const TEXT = "page/text";
/** A binding-shaped origin: not the provider, not the replay origin ⇒ the user. */
const BINDING = { binding: true };

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

let uuidCounter = 0;
Object.defineProperty(globalThis.crypto, "randomUUID", {
  value: () => `id-${++uuidCounter}`,
  configurable: true,
  writable: true,
});

beforeEach(() => {
  uuidCounter = 0;
});
afterEach(cleanup);

// ---------------------------------------------------------------------------
// Fixture + harness (see structural-undo.test.tsx for why the probe exists)
// ---------------------------------------------------------------------------

function node(text: string, children: SerializedBlock[] = []): SerializedBlock {
  return { type: TEXT, data: { text: [{ text }] }, expanded: true, children };
}

/** `A ⊃ A1`, then `B`, `C` at top level. */
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

function docRuns(runs: RichText): DocSourcedRuns {
  const doc = runsToXmlText(runs).doc;
  if (!doc) throw new Error("docRuns: seed XmlText is not attached to a doc");
  return projectableRunsOf(doc);
}

type Ctx = ReturnType<typeof useBlockEditor>;

function RowsProbe({ onCtx }: { onCtx: (ctx: Ctx) => void }) {
  const ctx = useBlockEditor();
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
  ctx: () => Ctx;
  id: (text: string) => string;
  row: (id: string) => Block | undefined;
  rowText: (id: string) => string;
  has: (id: string) => boolean;
  /**
   * Hold a live content owner for `id` seeded from `runs` (memory transport,
   * connected, so the seed IS the doc and the owner is authoritative at once)
   * and forward its closed runs to the context, as the text plugin would.
   */
  open: (id: string, runs: RichText) => Opened;
}

interface Opened {
  owner: BlockDocOwner;
  session: CollabSession;
  /** The runs edits the tracker emitted for this block, in order. */
  emitted: BlockRunsEdit[];
  /** Release the hold and let the deferred end (and the owner's finalize) run. */
  close: () => Promise<void>;
}

const plain = (runs: readonly { text: string }[]): string =>
  runs.map((r) => r.text).join("");

/** The owner doc's runs, widened off the projection brand for `toEqual`. */
const docOf = (owner: BlockDocOwner): RichText => owner.runsNow();

/**
 * Bring an owner's doc to `runs` under a binding-shaped origin — what a
 * relayed Lexical edit looks like on the canonical: a local transaction the run
 * tracker opens or extends a typing run for.
 */
function typeInto(owner: BlockDocOwner, runs: RichText): void {
  const opts = blockTextRunsOptions();
  const delta = editYDocState(
    Y.encodeStateAsUpdate(owner.doc),
    () => $spliceRunsInto(runs, opts.extensions),
    { nodes: [LinkNode, ...opts.nodes] },
  );
  Y.applyUpdate(owner.doc, delta, BINDING);
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
  const row = (id: string) => ctx().blocks.find((b) => b.id === id);
  return {
    ctx,
    id: (text) => {
      const id = byText.get(text);
      if (!id) throw new Error(`no seeded block with text "${text}"`);
      return id;
    },
    row,
    rowText: (id) =>
      plain(runsOf((row(id)?.data as { text?: unknown } | undefined)?.text)),
    has: (id) => row(id) !== undefined,
    open: (id, runs) => {
      const session = CollabSession.start(
        id,
        () => buildSeedStateFor(runs),
        "present",
        false,
      );
      const { owner } = session;
      owner.replicaConnection.acquire(); // the local provider seeds at connect()
      const emitted: BlockRunsEdit[] = [];
      const off = owner.onRunsEdit((edit) => {
        emitted.push(edit);
        ctx().recordTextEdit(edit);
      });
      return {
        owner,
        session,
        emitted,
        close: async () => {
          off();
          owner.replicaConnection.release();
          session.end();
          await act(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 1));
          });
        },
      };
    },
  };
}

/**
 * Let everything deferred land — a split's microtask record, a replay's
 * post-`await` patch dispatch, the queued undo turn behind an in-flight one.
 * `act` alone does not wait past its callback's own promise; one macrotask
 * drains every microtask chain in flight.
 */
const settle = () =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
const undo = async (h: Harness): Promise<void> => {
  await act(async () => h.ctx().undo());
  await settle();
};
const redo = async (h: Harness): Promise<void> => {
  await act(async () => h.ctx().redo());
  await settle();
};

/**
 * Hold an owner for the test's duration and ALWAYS release it — a session left
 * open by a failing assertion stays in the module registry under an id the
 * next test's fixture mints again, and that test then reads a stale doc.
 */
async function withOpen(
  h: Harness,
  id: string,
  runs: RichText,
  body: (opened: Opened) => Promise<void>,
): Promise<void> {
  const opened = h.open(id, runs);
  try {
    await body(opened);
  } finally {
    await opened.close();
  }
}

// ---------------------------------------------------------------------------

describe("the incident: type, delete, undo, undo", () => {
  it("reverts the typing after restoring the block — the doc is live again", async () => {
    const h = mount();
    const id = h.id("B");
    await withOpen(h, id, [{ text: "B" }], async (b) => {
      expect(docOf(b.owner)).toEqual([{ text: "B" }]);

      // A typing run, left OPEN (the idle window has not elapsed): the delete's
      // own recording must seal it first, so the run's entry sits below the
      // delete's — never after it, never lost.
      typeInto(b.owner, [{ text: "B typed" }]);
      expect(b.emitted).toHaveLength(0);
      await act(async () => h.ctx().bulkDelete([id]));
      expect(b.emitted).toHaveLength(1);
      expect(b.emitted[0]).toMatchObject({
        blockId: id,
        before: [{ text: "B" }],
        after: [{ text: "B typed" }],
      });
      expect(h.has(id)).toBe(false);

      // Ctrl+Z: the row comes back, carrying what the DOC held (the pin).
      await undo(h);
      expect(h.has(id)).toBe(true);
      expect(h.rowText(id)).toBe("B typed");
      expect(h.ctx().canUndo).toBe(true);

      // Ctrl+Z again: the typing reverts, on the live owner's doc. NOT a no-op.
      await undo(h);
      expect(docOf(b.owner)).toEqual([{ text: "B" }]);
      expect(h.ctx().canUndo).toBe(false);

      // And forward again, both.
      await redo(h);
      expect(docOf(b.owner)).toEqual([{ text: "B typed" }]);
      await redo(h);
      expect(h.has(id)).toBe(false);
    });
  });

  it("reverts the typing even when the block's owner is GONE — the row is the host", async () => {
    const h = mount();
    const id = h.id("B");
    const b = h.open(id, [{ text: "B" }]);
    typeInto(b.owner, [{ text: "B typed" }]);
    b.owner.closeTextRun();
    expect(b.emitted).toHaveLength(1);
    // The projection the seam would have written for that run, so the row
    // visibly carries the typed text before the delete.
    await act(async () =>
      h.ctx().projectText(id, docRuns([{ text: "B typed" }])),
    );
    expect(h.rowText(id)).toBe("B typed");

    // The editor unmounts and the owner finalizes: the pointer model's silent
    // no-op arm. There is no doc left in process.
    await b.close();
    expect(blockDocOwnerOf(id)).toBeNull();

    await act(async () => h.ctx().bulkDelete([id]));
    expect(h.has(id)).toBe(false);
    await undo(h);
    expect(h.rowText(id)).toBe("B typed");

    // The text entry replays onto the row (memory mode, no owner): "B typed"
    // → "B". Observable, hence not a no-op.
    await undo(h);
    expect(h.rowText(id)).toBe("B");
    expect(h.ctx().canUndo).toBe(false);
    await redo(h);
    expect(h.rowText(id)).toBe("B typed");
  });
});

describe("split is ONE entry: patch + the origin's truncation", () => {
  it("one Ctrl+Z restores the origin's text and removes the tail together", async () => {
    const h = mount();
    const id = h.id("B");
    await withOpen(h, id, [{ text: "bravo" }], async (b) => {
      // The row carries what the doc holds (as the projection would have written).
      await act(async () =>
        h.ctx().projectText(id, docRuns([{ text: "bravo" }])),
      );
      // The origin's focus handle: `truncateAt` edits the owner's doc the way the
      // bound editor's surgery would (a binding-origin transaction).
      const unregister = h.ctx().registerFocusHandle(id, {
        focus: () => {},
        truncateAt: (offset) => {
          const [head] = splitRuns(docOf(b.owner), offset);
          typeInto(b.owner, head);
        },
      });
      const countBefore = h.ctx().blocks.length;

      await act(async () =>
        h
          .ctx()
          .makeBlockAPI(id)
          .split(3, { runs: [{ text: "bravo" }] }),
      );
      await settle();
      expect(h.ctx().blocks).toHaveLength(countBefore + 1);
      expect(h.rowText(id)).toBe("bra");
      expect(docOf(b.owner)).toEqual([{ text: "bra" }]);
      const tail = h.ctx().blocks.find((row) => h.rowText(row.id) === "vo");
      expect(tail).toBeDefined();
      // The truncation ran inside `untracked`: the tracker recorded nothing.
      expect(b.emitted).toHaveLength(0);
      expect(h.ctx().canUndo).toBe(true);

      await undo(h);
      expect(h.ctx().canUndo).toBe(false); // exactly one entry
      expect(h.ctx().blocks).toHaveLength(countBefore);
      expect(h.has(tail!.id)).toBe(false);
      expect(docOf(b.owner)).toEqual([{ text: "bravo" }]);
      expect(h.rowText(id)).toBe("bravo");

      await redo(h);
      expect(h.ctx().blocks).toHaveLength(countBefore + 1);
      expect(h.has(tail!.id)).toBe(true);
      expect(docOf(b.owner)).toEqual([{ text: "bra" }]);

      unregister();
    });
  });
});

describe("Enter over a selected range is ONE entry: the range goes, the line splits", () => {
  it("mid-line: the tail starts after the range, one Ctrl+Z restores both", async () => {
    const h = mount();
    const id = h.id("B");
    await withOpen(h, id, [{ text: "bravo" }], async (b) => {
      await act(async () =>
        h.ctx().projectText(id, docRuns([{ text: "bravo" }])),
      );
      const unregister = h.ctx().registerFocusHandle(id, {
        focus: () => {},
        truncateAt: (offset) => {
          const [head] = splitRuns(docOf(b.owner), offset);
          typeInto(b.owner, head);
        },
      });
      const countBefore = h.ctx().blocks.length;

      // "b[ra]vo" + Enter → "b" | "vo".
      await act(async () =>
        h
          .ctx()
          .makeBlockAPI(id)
          .split(1, { runs: [{ text: "bravo" }], deleteTo: 3 }),
      );
      await settle();
      expect(h.ctx().blocks).toHaveLength(countBefore + 1);
      expect(docOf(b.owner)).toEqual([{ text: "b" }]);
      const tail = h.ctx().blocks.find((row) => h.rowText(row.id) === "vo");
      expect(tail).toBeDefined();
      expect(b.emitted).toHaveLength(0);

      await undo(h);
      expect(h.ctx().canUndo).toBe(false); // exactly one entry
      expect(h.has(tail!.id)).toBe(false);
      expect(docOf(b.owner)).toEqual([{ text: "bravo" }]);

      unregister();
    });
  });

  it("from the line's start: the origin keeps the text after the range, one Ctrl+Z", async () => {
    const h = mount();
    const id = h.id("B");
    await withOpen(h, id, [{ text: "bravo" }], async (b) => {
      await act(async () =>
        h.ctx().projectText(id, docRuns([{ text: "bravo" }])),
      );
      const unregister = h.ctx().registerFocusHandle(id, {
        focus: () => {},
        deleteRange: (from, to) => {
          const runs = docOf(b.owner);
          typeInto(b.owner, [
            ...splitRuns(runs, from)[0],
            ...splitRuns(runs, to)[1],
          ]);
        },
      });
      const countBefore = h.ctx().blocks.length;

      // "[bra]vo" + Enter → "" above, the origin keeps "vo".
      await act(async () =>
        h
          .ctx()
          .makeBlockAPI(id)
          .split(0, { runs: [{ text: "bravo" }], deleteTo: 3 }),
      );
      await settle();
      expect(h.ctx().blocks).toHaveLength(countBefore + 1);
      expect(h.has(id)).toBe(true);
      expect(docOf(b.owner)).toEqual([{ text: "vo" }]);
      expect(b.emitted).toHaveLength(0);

      await undo(h);
      expect(h.ctx().canUndo).toBe(false);
      expect(h.ctx().blocks).toHaveLength(countBefore);
      expect(docOf(b.owner)).toEqual([{ text: "bravo" }]);

      unregister();
    });
  });
});

describe("merge into a mounted target is ONE entry", () => {
  it("undo restores the source row and un-appends the target's doc", async () => {
    const h = mount();
    const target = h.id("A");
    const source = h.id("A1");
    await withOpen(h, target, [{ text: "A" }], async (a) => {
      const unregister = h.ctx().registerFocusHandle(target, {
        focus: () => {},
        appendRunsAtEnd: (runs) =>
          typeInto(a.owner, mergeRuns(docOf(a.owner), runs)),
      });

      await act(async () =>
        h
          .ctx()
          .makeBlockAPI(source)
          .merge({ runs: [{ text: "A1" }] }),
      );
      await settle();
      expect(h.has(source)).toBe(false);
      expect(docOf(a.owner)).toEqual([{ text: "AA1" }]);
      expect(h.rowText(target)).toBe("AA1");
      expect(a.emitted).toHaveLength(0); // the append ran inside `untracked`
      expect(h.ctx().canUndo).toBe(true);

      await undo(h);
      expect(h.ctx().canUndo).toBe(false);
      expect(h.has(source)).toBe(true);
      expect(h.rowText(source)).toBe("A1");
      expect(docOf(a.owner)).toEqual([{ text: "A" }]);
      expect(h.rowText(target)).toBe("A");

      await redo(h);
      expect(h.has(source)).toBe(false);
      expect(docOf(a.owner)).toEqual([{ text: "AA1" }]);

      unregister();
    });
  });
});

describe("recordDocEdit", () => {
  it("records exactly one entry, under its own label, and the tracker none", async () => {
    const h = mount();
    const id = h.id("B");
    await withOpen(h, id, [{ text: "B" }], async (b) => {
      // A typing run left open: `recordDocEdit` seals it first, so the format
      // entry sits ABOVE a fully recorded run, never inside it.
      typeInto(b.owner, [{ text: "Bx" }]);

      h.ctx().recordDocEdit(id, "Format text", () => {
        typeInto(b.owner, [{ text: "Bx", marks: ["bold"] }]);
      });
      // Deferred one microtask inside `recordDocEdit`; nothing yet.
      expect(docOf(b.owner)).toEqual([{ text: "Bx" }]);
      await settle();
      expect(docOf(b.owner)).toEqual([{ text: "Bx", marks: ["bold"] }]);
      // The run was sealed by the recorder (one tracker edit: "B" → "Bx"); the
      // format itself was invisible to the tracker.
      expect(b.emitted).toHaveLength(1);
      expect(b.emitted[0]).toMatchObject({
        before: [{ text: "B" }],
        after: [{ text: "Bx" }],
      });

      await undo(h); // the format
      expect(docOf(b.owner)).toEqual([{ text: "Bx" }]);
      expect(h.ctx().canUndo).toBe(true);
      await undo(h); // the typing
      expect(docOf(b.owner)).toEqual([{ text: "B" }]);
      expect(h.ctx().canUndo).toBe(false);
      await redo(h);
      await redo(h);
      expect(docOf(b.owner)).toEqual([{ text: "Bx", marks: ["bold"] }]);
    });
  });

  it("records nothing when the edit changed nothing", async () => {
    const h = mount();
    const id = h.id("B");
    await withOpen(h, id, [{ text: "B" }], async () => {
      h.ctx().recordDocEdit(id, "Format text", () => {});
      await settle();
      expect(h.ctx().canUndo).toBe(false);
    });
  });
});

describe("a flush during an in-flight replay lands", () => {
  it("the run sealed by the second undo's pending flush is recorded and replayed in turn", async () => {
    const h = mount();
    const x = h.id("B");
    const y = h.id("C");
    // X: a SERVER-synced owner whose doc is empty and unsynced, so a replay
    // onto it waits (push-based) for the transport's `sync` — the in-flight
    // window this test needs. Nothing is fetched: no block-doc read is
    // mounted (`useLiveRow` is stubbed pending), and the state is delivered by
    // hand below.
    const xSession = CollabSession.start(
      x,
      () => buildSeedStateFor([{ text: "X" }]),
      "present",
      true,
    );
    xSession.owner.replicaConnection.acquire();
    try {
      expect(xSession.owner.provider.isSynced).toBe(false);
      // Y: an ordinary live owner with its runs forwarded to the context.
      await withOpen(h, y, [{ text: "Y" }], async (yOpened) => {
        // The entry for X: recorded as data, exactly as the tracker would emit
        // it (inside `act`, so the probe sees the `canUndo` flip).
        await act(async () =>
          h.ctx().recordTextEdit({
            blockId: x,
            before: [{ text: "X" }],
            after: [{ text: "X!" }],
          }),
        );
        expect(h.ctx().canUndo).toBe(true);

        // Turn 1: pops X's entry; its replay waits on X's sync.
        await undo(h);
        expect(h.ctx().canUndo).toBe(false);
        expect(docOf(xSession.owner)).toEqual([]);

        // Meanwhile the user types into Y (run open, not yet recorded)…
        typeInto(yOpened.owner, [{ text: "Y2" }]);
        expect(yOpened.emitted).toHaveLength(0);
        // …and presses Ctrl+Z again. The turn queues behind the in-flight one;
        // a turn runs its pending flushes when it STARTS, so Y's run stays open
        // (and keeps absorbing keystrokes) until turn 1 settles.
        await undo(h);
        expect(yOpened.emitted).toHaveLength(0);
        expect(docOf(yOpened.owner)).toEqual([{ text: "Y2" }]); // not yet replayed

        // X's transport answers: turn 1 completes on host A, turn 2 starts —
        // its flush seals Y's run, the entry LANDS (not swallowed by the replay
        // guard), and the pop takes exactly that entry.
        await act(async () => {
          const seed = buildSeedStateFor([{ text: "X!" }]);
          xSession.owner.provider.onServerState(
            btoa(String.fromCharCode(...seed)),
          );
        });
        expect(yOpened.emitted).toHaveLength(1);
        expect(docOf(xSession.owner)).toEqual([{ text: "X" }]);
        expect(docOf(yOpened.owner)).toEqual([{ text: "Y" }]);
        expect(h.ctx().canUndo).toBe(false);
        expect(h.ctx().canRedo).toBe(true);
      });
    } finally {
      xSession.owner.replicaConnection.release();
      xSession.end();
      await settle();
    }
  });
});
