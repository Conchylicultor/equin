// `RowTruth` — what THIS editor knows about a block id in server truth
// (`internal/row-truth.ts`), derived by `rowTruthOf` on the editor context:
//
//   present  — in the authoritative rows now
//   removed  — was in them at some earlier push, is not now
//   unseen   — never seen there by this editor
//
// The content-doc seam reads it to decide whether a `data.text` seed may be
// applied without waiting for the server. Every delete is a trash whose stored
// doc survives, so a re-created row must read `removed` (wait for the
// surviving doc), never `unseen` (pre-seed, which would merge with that doc as
// a second paragraph). Memory mode (`persist={false}`) is the honest harness:
// its `serverData` IS its rows, so a delete leaves server truth at once and an
// undo re-enters it at once — the same transitions a server push drives.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { renderWithTransport } from "@plugins/primitives/plugins/networking/web/testing";
import { useEffect, useMemo } from "react";
import { PluginProvider } from "@plugins/framework/plugins/web-sdk/core";
import { UndoRedoProvider } from "@plugins/primitives/plugins/undo-redo/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  newBlockId,
  planForestInsert,
  withMintedIds,
  type Block,
  type SerializedBlock,
} from "../../core";
import { fromNodes } from "../internal/optimistic-block-ops";
import { BlockEditorProvider, useBlockEditor } from "../block-editor-context";

const PAGE_ID = "page-1";
const TEXT = "page/text";

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

function node(text: string): SerializedBlock {
  return {
    type: TEXT,
    data: { text: [{ text }] },
    expanded: true,
    children: [],
  };
}

function seed(): Block[] {
  const forest = [node("A"), node("B"), node("C")];
  const { nodes } = planForestInsert({
    pageId: PAGE_ID,
    parentId: PAGE_ID,
    rootRanks: Rank.nBetween(null, null, forest.length),
    forest: withMintedIds(forest),
  });
  return fromNodes(nodes, []);
}

type Ctx = ReturnType<typeof useBlockEditor>;

/** Stands in for `BlockEditorInner` — see `structural-undo.test.tsx`'s fidelity note. */
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

function mount(): { ctx: () => Ctx; id: (text: string) => string } {
  const sink: { ctx: Ctx | null } = { ctx: null };
  const initialBlocks = seed();
  renderWithTransport(
    <PluginProvider plugins={[]}>
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
  const byText = new Map(
    initialBlocks.map((b) => {
      const runs = (b.data as { text: { text: string }[] }).text;
      return [runs[0]!.text, b.id] as const;
    }),
  );
  return {
    ctx: () => {
      if (!sink.ctx) throw new Error("provider never rendered its child");
      return sink.ctx;
    },
    id: (text) => {
      const id = byText.get(text);
      if (!id) throw new Error(`no seeded block with text "${text}"`);
      return id;
    },
  };
}

describe("rowTruthOf", () => {
  it("a minted id is unseen, a seeded row present, a deleted row removed, a restored row present again", async () => {
    const h = mount();
    // Client-minted, never in server truth: nothing can be stored for it.
    expect(h.ctx().rowTruthOf(newBlockId())).toBe("unseen");

    const b = h.id("B");
    expect(h.ctx().rowTruthOf(b)).toBe("present");

    // A confirmed delete: the id left server truth, but this editor SAW it
    // there — its doc may survive, so it must not read as unseen.
    await act(async () => h.ctx().bulkDelete([b]));
    expect(h.ctx().blocks.some((row) => row.id === b)).toBe(false);
    expect(h.ctx().rowTruthOf(b)).toBe("removed");

    // Undo re-creates the row under its ORIGINAL id: present once server truth
    // holds it again (immediately, in memory mode).
    await act(async () => h.ctx().undo());
    expect(h.ctx().rowTruthOf(b)).toBe("present");

    // …and a redo of the delete is removed again, never unseen: the set of
    // ever-seen ids only grows.
    await act(async () => h.ctx().redo());
    expect(h.ctx().rowTruthOf(b)).toBe("removed");
  });

  it("an id that was never in server truth stays unseen across unrelated pushes", async () => {
    const h = mount();
    const stranger = newBlockId();
    await act(async () => h.ctx().bulkDelete([h.id("C")]));
    await act(async () => h.ctx().undo());
    expect(h.ctx().rowTruthOf(stranger)).toBe("unseen");
  });
});
