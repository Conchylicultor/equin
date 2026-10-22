// The row model's ONE text rule, at the write funnel:
//
//     `data.text` is present on a row IFF its type accepts text.
//
// Both halves used to be a 400 at the server write boundary, from opposite
// directions:
//
//  - **text → void.** The `doc → data.text` projection flushes from the text
//    editor's UNMOUNT — which is precisely what a conversion into a void type
//    causes — and `projectText` gated only on the row still existing, never on
//    what the row had just become. Every `/divider` posted a patch carrying
//    `text` at a row the server already knew was a divider. Harmless-looking
//    (the conversion itself is a different, successful write) but it parks the
//    page's save indicator on a failure no user action can clear.
//  - **void → text.** `emptyRowData()` is the target's defaults MINUS `text`,
//    and a void row has no prior projection to carry across — so *Turn into →
//    Text* wrote `{}` against a schema that REQUIRES `text`. That patch is the
//    only carrier of the conversion, so the whole thing was rejected and lost
//    on reload.
//
// The fixtures are made-up types (`__text__` / `__void__`): if any of these pass
// because something recognised `"divider"`, the abstraction has leaked.
//
// ## Why the plugins list is not empty
//
// `structural-undo.test.tsx` mounts `<PluginProvider plugins={[]}>`, which is
// right for what IT pins (block handles supply only `anchorTypes` /
// `wrapOnConvert`, which no case there exercises). Reusing that verbatim here
// would make the whole suite VACUOUS: with no contributions every handle lookup
// misses, the funnel's "no registered handle, no opinion" branch returns every
// row untouched, and each assertion below would pass identically against the
// unfixed code. Registering the fixtures IS the test.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { renderWithTransport } from "@plugins/primitives/plugins/networking/web/testing";
import { useEffect, useMemo } from "react";
import { z } from "zod";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { UndoRedoProvider } from "@plugins/primitives/plugins/undo-redo/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  defineBlock,
  runsToXmlText,
  textBlockSchema,
  type Block,
  type RichText,
} from "../../core";
import {
  projectableRunsOf,
  type DocSourcedRuns,
} from "../internal/doc-sourced-runs";
import type { BlockOverlayOp } from "../internal/optimistic-block-ops";
import { useMemoryBlockStore, type SettledBlockStore } from "../block-store";
import {
  BlockEditorProviderInner,
  useBlockEditor,
} from "../block-editor-context";
import { Editor } from "../slots";

const PAGE_ID = "page-1";
const TEXT = "__text__";
const VOID = "__void__";

// ---------------------------------------------------------------------------
// Fixture block types
// ---------------------------------------------------------------------------

// Text-bearing: `textBlockSchema` stamps the brand `defineBlock` derives the
// text lens from, so `acceptsText` is true and `handle.text` exists. The
// registration may NOT name a `component` — the slot's union reserves that arm
// for text-less handles (a text type owning its own component is the bug that
// unmounted Lexical mid-conversion).
const textHandle = defineBlock({
  type: TEXT,
  schema: textBlockSchema({}),
  label: "Fixture text",
  empty: () => ({ text: [] }),
});

// Void: no `text` key in the schema ⇒ `acceptsText` false, `handle.text`
// undefined. `data` carries a non-text field so the strip is visibly a strip of
// `text` alone and not a blanket reset of the blob.
const voidHandle = defineBlock({
  type: VOID,
  schema: z.object({ tint: z.string().optional() }),
  label: "Fixture void",
  empty: () => ({}),
});

// Nothing mounts these — the harness renders only `RowsProbe` — so the required
// component for the text-less arm is a stub.
const plugins = [
  {
    id: "row-text-invariant-fixture",
    description: "block-type fixtures for the row text invariant",
    contributions: [
      Editor.Block({ id: `${TEXT}-block`, match: TEXT, block: textHandle }),
      Editor.Block({
        id: `${VOID}-block`,
        match: VOID,
        block: voidHandle,
        component: () => null,
      }),
    ],
  } as unknown as LoadedPlugin,
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Ctx = ReturnType<typeof useBlockEditor>;

function row(id: string, type: string, data: unknown, rank: string): Block {
  return {
    id,
    pageId: PAGE_ID,
    parentId: null,
    type,
    data: data as Block["data"],
    rank: Rank.from(rank),
    expanded: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as Block;
}

/**
 * `rowsRef` is populated by a CONSUMER effect in production
 * (`block-editor.tsx`), and every mutation snapshots it as its `before`. Without
 * a stand-in that mirrors the same derivation, every mutation here reads an
 * empty row set, no-ops, and the suite passes vacuously — the same reason
 * `structural-undo.test.tsx` and `block-selection.test.tsx` keep one.
 */
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
  /** Current row, by id. */
  row: (id: string) => Block;
  /** `data` of the current row, as a plain record. */
  data: (id: string) => Record<string, unknown>;
  /** Every overlay op the store was handed, in order. */
  dispatched: () => BlockOverlayOp[];
}

/**
 * Mounts the provider over a SPIED memory store.
 *
 * The spy is what buys the one assertion the rows alone cannot make: *no write
 * was dispatched at all*, as distinct from *an empty write was applied*. The
 * fix's whole point in the text→void direction is that the projection's patch
 * now diffs to nothing and is never sent — a version that merely sent
 * `{ data: {} }` instead would leave the rows identical here while still posting
 * a pointless write on every conversion.
 */
function mount(initialBlocks: Block[]): Harness {
  const sink: { ctx: Ctx | null } = { ctx: null };
  const dispatched: BlockOverlayOp[] = [];

  function Host() {
    const store = useMemoryBlockStore({ initialBlocks });
    const spied = useMemo<SettledBlockStore>(
      () => ({
        ...store,
        dispatch: (v: BlockOverlayOp) => {
          dispatched.push(v);
          store.dispatch(v);
        },
      }),
      [store],
    );
    return (
      <BlockEditorProviderInner
        store={spied}
        pageId={PAGE_ID}
        serverSync={false}
        rootId={null}
      >
        <RowsProbe
          onCtx={(next) => {
            sink.ctx = next;
          }}
        />
      </BlockEditorProviderInner>
    );
  }

  renderWithTransport(
    <PluginProvider plugins={plugins}>
      <UndoRedoProvider>
        <Host />
      </UndoRedoProvider>
    </PluginProvider>,
  );

  const ctx = () => {
    if (!sink.ctx) throw new Error("provider never rendered its child");
    return sink.ctx;
  };
  const find = (id: string): Block => {
    const found = ctx().blocks.find((b) => b.id === id);
    if (!found) throw new Error(`no row ${id}`);
    return found;
  };
  return {
    ctx,
    row: find,
    data: (id) => (find(id).data ?? {}) as Record<string, unknown>,
    dispatched: () => dispatched,
  };
}

/**
 * Runs read out of a content doc. `projectText` only accepts `DocSourcedRuns`
 * (a brand `projectableRunsOf` alone can mint), so the fixture has to go through
 * a real doc rather than casting — the same route `use-collab-block-doc`'s flush
 * takes.
 */
function docRuns(runs: RichText): DocSourcedRuns {
  const doc = runsToXmlText(runs).doc;
  if (!doc) throw new Error("docRuns: seed XmlText is not attached to a doc");
  return projectableRunsOf(doc);
}

afterEach(cleanup);

// ---------------------------------------------------------------------------

describe("the row text invariant, enforced at the write funnel", () => {
  it("drops a projection aimed at a row that just became void — and sends nothing", async () => {
    const h = mount([row("A", TEXT, { text: [{ text: "hello" }] }, "a0")]);

    await act(async () => {
      h.ctx().makeBlockAPI("A").convertTo(VOID, voidHandle.emptyRowData());
    });
    expect(h.row("A").type).toBe(VOID);
    expect(h.data("A")).not.toHaveProperty("text");

    // The flush the unmounting text editor fires straight after the conversion.
    const beforeCount = h.dispatched().length;
    await act(async () => {
      h.ctx().projectText("A", docRuns([{ text: "hello" }]));
    });

    // The row is untouched…
    expect(h.data("A")).not.toHaveProperty("text");
    // …and nothing went to the wire. A conformed write that still POSTed an
    // empty-`data` update would pass the line above and fail this one.
    expect(h.dispatched().length).toBe(beforeCount);
  });

  it("fills `text` when converting a void row INTO a text type", async () => {
    const h = mount([row("A", VOID, { tint: "warn" }, "a0")]);

    await act(async () => {
      h.ctx().makeBlockAPI("A").convertTo(TEXT, textHandle.emptyRowData());
    });

    expect(h.row("A").type).toBe(TEXT);
    // Present, not merely falsy: the server rejects a MISSING `text` on a
    // text-bearing type just as loudly as a stray one on a void type.
    expect(h.data("A")).toHaveProperty("text");
    expect(h.data("A").text).toEqual([]);
  });

  it("carries an existing projection across a text→text conversion, byte for byte", async () => {
    const runs = [{ text: "keep me", marks: ["bold"] }];
    const h = mount([row("A", TEXT, { text: runs }, "a0")]);

    await act(async () => {
      h.ctx().makeBlockAPI("A").convertTo(TEXT, textHandle.emptyRowData());
    });

    // The fill must not degenerate into a blanket `[]` — this is the property
    // `preserveText` exists for, and the one a careless conform would eat.
    expect(h.data("A").text).toEqual(runs);
  });

  it("keeps `text` on a row whose type has no registered handle", async () => {
    // The branch that decides between "strip" and "leave alone" for an
    // unresolvable type. Collapsing it into the void branch (the shape
    // `markdown-apply`'s `survivorData` can safely use, because IT never strips)
    // would silently delete the text of every row whose block plugin was
    // renamed, removed, or simply not mounted by this host.
    const h = mount([
      row("A", "__gone__", { text: [{ text: "orphan" }] }, "a0"),
    ]);

    await act(async () => {
      h.ctx().makeBlockAPI("A").update({ tint: "warn" });
    });

    expect(h.data("A").text).toEqual([{ text: "orphan" }]);
    expect(h.data("A").tint).toBe("warn");
  });

  it("does not resurrect `text` when a void row's other fields are written", async () => {
    const h = mount([row("A", VOID, {}, "a0")]);

    await act(async () => {
      h.ctx().makeBlockAPI("A").update({ tint: "info" });
    });

    expect(h.data("A")).not.toHaveProperty("text");
    expect(h.data("A").tint).toBe("info");
  });
});
