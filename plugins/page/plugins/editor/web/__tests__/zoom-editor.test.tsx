// The zoomed editor (`rootId`) on the in-memory store: the top-level gestures
// land inside the view, the ones that cannot are refused before they reach the
// undo stack, and a root that is not there renders as gone.
//
// Same harness shape as `structural-undo.test.tsx` (read its header): the
// PROVIDER mounts with a probe standing in for `BlockEditorInner`, because the
// real surface would need every block type, Lexical and a Yjs binding per row.
// The one case that mounts the real `<BlockEditor>` is the gone state — which
// renders before any row does, so it needs none of that.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { renderWithTransport } from "@plugins/primitives/plugins/networking/web/testing";
import { useEffect, useMemo } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { UndoRedoProvider } from "@plugins/primitives/plugins/undo-redo/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  defineBlock,
  planForestInsert,
  textBlockSchema,
  withMintedIds,
  type Block,
  type SerializedBlock,
} from "../../core";
import { Editor } from "../slots";
import { fromNodes } from "../internal/optimistic-block-ops";
import { BlockEditorProvider, useBlockEditor } from "../block-editor-context";
import { BlockEditor } from "../components/block-editor";

const PAGE_ID = "page-1";
const TEXT = "page/text";

const textHandle = defineBlock({
  type: TEXT,
  schema: textBlockSchema({}),
  label: "Fixture text",
  empty: () => ({ text: [] }),
});
const plugins = [
  {
    id: "zoom-fixture",
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

function node(text: string, children: SerializedBlock[] = []): SerializedBlock {
  return { type: TEXT, data: { text: [{ text }] }, expanded: true, children };
}

/** `P ⊃ [R ⊃ [R1, R2]]`, then `S` — the zoom root R sits one level down. */
function seed(): Block[] {
  const forest = [node("P", [node("R", [node("R1"), node("R2")])]), node("S")];
  const { nodes } = planForestInsert({
    pageId: PAGE_ID,
    parentId: PAGE_ID,
    rootRanks: Rank.nBetween(null, null, forest.length),
    forest: withMintedIds(forest),
  });
  return fromNodes(nodes, []);
}

type Ctx = ReturnType<typeof useBlockEditor>;

/** Stands in for `BlockEditorInner`: feeds `rowsRef` the full, rank-sorted rows. */
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

function mount() {
  const sink: { ctx: Ctx | null } = { ctx: null };
  const initialBlocks = seed();
  const byText = new Map(
    initialBlocks.map((b) => {
      const runs = (b.data as { text: { text: string }[] }).text;
      return [runs[0]!.text, b.id] as const;
    }),
  );
  const id = (text: string) => {
    const found = byText.get(text);
    if (!found) throw new Error(`no seeded block "${text}"`);
    return found;
  };
  renderWithTransport(
    <PluginProvider plugins={plugins}>
      <UndoRedoProvider>
        <BlockEditorProvider
          pageId={PAGE_ID}
          persist={false}
          initialBlocks={initialBlocks}
          rootId={id("R")}
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
  /** R's children, in rank order, by id. */
  const childrenOfRoot = () =>
    ctx()
      .blocks.filter((b) => b.parentId === id("R"))
      .sort((a, b) => Rank.compare(a.rank, b.rank))
      .map((b) => b.id);
  const settle = () =>
    act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  return { ctx, id, childrenOfRoot, settle };
}

const EMPTY = { text: [] };

describe("zoomed editor — top-level gestures land inside the view", () => {
  it("states its scope", () => {
    const h = mount();
    expect(h.ctx().scope).toEqual({
      rootId: h.id("R"),
      contentParentId: h.id("R"),
    });
  });

  it("insert (the click below the last line) appends to the root", async () => {
    const h = mount();
    await act(async () => h.ctx().insert(TEXT, EMPTY));
    await h.settle();
    expect(h.childrenOfRoot()).toEqual([
      h.id("R1"),
      h.id("R2"),
      expect.any(String),
    ]);
  });

  it("insertFirst lands as the root's first child", async () => {
    const h = mount();
    await act(async () => h.ctx().insertFirst(TEXT, EMPTY));
    await h.settle();
    const kids = h.childrenOfRoot();
    expect(kids.slice(1)).toEqual([h.id("R1"), h.id("R2")]);
    expect(kids).toHaveLength(3);
  });

  it("an anchorless paste lands at the start of the root", async () => {
    const h = mount();
    await act(async () =>
      h.ctx().paste({ blocks: [node("new")], afterId: null }),
    );
    await h.settle();
    const kids = h.childrenOfRoot();
    expect(kids).toHaveLength(3);
    expect(kids.slice(1)).toEqual([h.id("R1"), h.id("R2")]);
  });

  it("a paste anchored ON the root lands below it, as its first child", async () => {
    const h = mount();
    await act(async () =>
      h.ctx().paste({ blocks: [node("new")], afterId: h.id("R") }),
    );
    await h.settle();
    const kids = h.childrenOfRoot();
    expect(kids).toHaveLength(3);
    expect(kids.slice(1)).toEqual([h.id("R1"), h.id("R2")]);
    // Nothing landed beside the root.
    expect(h.ctx().blocks.filter((b) => b.parentId === h.id("P"))).toHaveLength(
      1,
    );
  });

  it("insertAfter on the root (the rail +) inserts its first child", async () => {
    const h = mount();
    await act(async () => {
      h.ctx().makeBlockAPI(h.id("R")).insertAfter(TEXT, EMPTY);
    });
    await h.settle();
    const kids = h.childrenOfRoot();
    expect(kids).toHaveLength(3);
    expect(kids.slice(1)).toEqual([h.id("R1"), h.id("R2")]);
  });
});

describe("zoomed editor — writes that would leave the view are refused", () => {
  it("a move out of the root changes nothing and records nothing", async () => {
    const h = mount();
    const before = h.ctx().blocks;
    await act(async () => h.ctx().move(h.id("R1"), "after", h.id("S")));
    await h.settle();
    expect(h.ctx().blocks).toBe(before);
    expect(h.ctx().canUndo).toBe(false);
  });

  it("an outdent past the root is refused, and `admits` says so ahead of time", async () => {
    const h = mount();
    const op = { kind: "outdent" as const, blockIds: [h.id("R1")] };
    expect(h.ctx().admits(op)).toBe(false);
    // Inside the view the same question is yes.
    expect(h.ctx().admits({ kind: "indent", blockIds: [h.id("R2")] })).toBe(
      true,
    );
    const before = h.ctx().blocks;
    await act(async () => h.ctx().outdentBlocks([h.id("R1")]));
    await h.settle();
    expect(h.ctx().blocks).toBe(before);
    expect(h.ctx().canUndo).toBe(false);
  });

  it("a sibling split of the root is refused whole", async () => {
    const h = mount();
    const before = h.ctx().blocks;
    await act(async () => {
      h.ctx()
        .makeBlockAPI(h.id("R"))
        .split(1, { runs: [{ text: "R" }] });
    });
    await h.settle();
    expect(h.ctx().blocks).toBe(before);
    expect(h.ctx().canUndo).toBe(false);
  });

  it("a selection delete naming the root empties it instead", async () => {
    const h = mount();
    await act(async () =>
      h.ctx().bulkDelete([h.id("R"), h.id("R1"), h.id("R2")]),
    );
    await h.settle();
    const ids = h.ctx().blocks.map((b) => b.id);
    expect(ids).toContain(h.id("R"));
    expect(h.childrenOfRoot()).toEqual([]);
    expect(h.ctx().canUndo).toBe(true);
  });
});

describe("zoomed editor — a root that is not there", () => {
  it("renders the gone state rather than an empty list", () => {
    renderWithTransport(
      <PluginProvider plugins={plugins}>
        <UndoRedoProvider>
          <BlockEditor
            persist={false}
            initialContent={[node("A")]}
            rootId="block-not-here"
          />
        </UndoRedoProvider>
      </PluginProvider>,
    );
    expect(screen.getByText("This block no longer exists.")).toBeTruthy();
  });
});
