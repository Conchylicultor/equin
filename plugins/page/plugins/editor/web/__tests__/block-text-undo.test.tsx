// A block's own plain-text surface participates in the DOCUMENT's undo stack,
// synchronously.
//
// The bug this suite pins: pasting inside a `/code` block could not be undone.
// The textarea declared no undo owner, so `mod+z` resolved to the page surface
// and the shortcut manager `preventDefault()`ed the browser's own textarea
// history — while the only thing recording was a DEBOUNCED `editor.update()`.
// For up to 500 ms nothing at all could reverse the paste, and a Cmd+Z in that
// window reversed an unrelated earlier document edit instead. `math/equation`
// reproduced the same chain byte for byte.
//
// So the property under test is not "undo works" but WHEN the entry exists:
//
//   the entry is on the stack before any row write has been dispatched.
//
// Everything else follows from `useBlockPlainText` owning both halves —
// recording on the keystroke, persisting on a timer — which is why a burst is
// one entry rather than one per character, and why a pause starts the next.
//
// ## Fidelity
//
// Same harness as `structural-undo.test.tsx`, for the same reasons: the
// PROVIDER only, with a `RowsProbe` standing in for `BlockEditorInner`. That
// stand-in is load-bearing — `rowsRef` is populated by a CONSUMER effect, and
// without it every mutation reads an empty row set and the suite passes
// vacuously. An empty plugin list is the right fidelity: no block handle is
// registered, so `conformRowText` has no opinion and the row's `data` is
// written through untouched, which is exactly what a code block's `{code}` is.
//
// The clock: `test/setup.ts` fakes `Date` only (timers stay real), so a "pause
// past the coalesce window" is `vi.setSystemTime` — `recordEntry` reads
// `Date.now()` — while the persist debounce is driven by a real short timer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderWithTransport } from "@plugins/primitives/plugins/networking/web/testing";
import { useEffect, useMemo } from "react";
import { PluginProvider } from "@plugins/framework/plugins/web-sdk/core";
import { UndoRedoProvider } from "@plugins/primitives/plugins/undo-redo/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  planForestInsert,
  withMintedIds,
  type Block,
  type SerializedBlock,
} from "../../core";
import { fromNodes } from "../internal/optimistic-block-ops";
import { BlockEditorProvider, useBlockEditor } from "../block-editor-context";
import {
  BlockTextArea,
  useBlockPlainText,
} from "../components/block-text-area";

const PAGE_ID = "page-1";
const CODE = "page/code-block";

// Readable, reproducible ids, as in `structural-undo.test.tsx`.
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
// Harness
// ---------------------------------------------------------------------------

function seed(): Block[] {
  const forest: SerializedBlock[] = [
    { type: CODE, data: { code: "" }, expanded: true, children: [] },
  ];
  const { nodes } = planForestInsert({
    pageId: PAGE_ID,
    parentId: PAGE_ID,
    rootRanks: Rank.nBetween(null, null, forest.length),
    forest: withMintedIds(forest),
  });
  return fromNodes(nodes, []);
}

type Ctx = ReturnType<typeof useBlockEditor>;

/** See the fidelity note: `rowsRef` is fed by a consumer, never by the provider. */
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

/**
 * The block's own surface, shaped like the code block's: a plain-text control
 * beside a SECOND row-data control (its language Select), which is what makes
 * the two recorders' coalescing reachable at all.
 */
function SourceProbe({
  blockId,
  persistMs,
}: {
  blockId: string;
  persistMs: number;
}) {
  const ctx = useBlockEditor();
  const row = ctx.blocks.find((b) => b.id === blockId);
  const data = (row?.data ?? {}) as { code?: string; language?: string };
  const editor = useMemo(() => ctx.makeBlockAPI(blockId), [ctx, blockId]);
  const languageRef = useLatestRef(data.language);
  const text = useBlockPlainText({
    blockId,
    isFocused: true,
    editor,
    value: String(data.code ?? ""),
    rowData: (code) => ({ code, language: languageRef.current }),
    label: "code",
    persistMs,
  });
  return (
    <>
      <BlockTextArea text={text} aria-label="code" />
      <button
        type="button"
        aria-label="set language"
        onClick={() => editor.update({ code: text.value, language: "ts" })}
      />
    </>
  );
}

interface Harness {
  ctx: () => Ctx;
  blockId: string;
  /** The live textarea. */
  ta: () => HTMLTextAreaElement;
  /** What the ROW holds — i.e. what a write has actually dispatched. */
  row: () => string;
  /** The row's other data field, written by the second (row-data) recorder. */
  language: () => string | undefined;
}

function mount(persistMs = 60_000): Harness {
  const sink: { ctx: Ctx | null } = { ctx: null };
  const initialBlocks = seed();
  const blockId = initialBlocks[0]!.id;
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
          <SourceProbe blockId={blockId} persistMs={persistMs} />
        </BlockEditorProvider>
      </UndoRedoProvider>
    </PluginProvider>,
  );
  const ctx = () => {
    if (!sink.ctx) throw new Error("provider never rendered its child");
    return sink.ctx;
  };
  return {
    ctx,
    blockId,
    ta: () => screen.getByLabelText("code") as HTMLTextAreaElement,
    row: () => {
      const b = ctx().blocks.find((r) => r.id === blockId);
      return String((b?.data as { code?: string } | undefined)?.code ?? "");
    },
    language: () => {
      const b = ctx().blocks.find((r) => r.id === blockId);
      return (b?.data as { language?: string } | undefined)?.language;
    },
  };
}

/** One keystroke: the caret sits at the end of what was typed. */
async function type(h: Harness, next: string): Promise<void> {
  const ta = h.ta();
  await act(async () => {
    fireEvent.keyDown(ta, { key: next.at(-1) ?? "a" });
    fireEvent.change(ta, { target: { value: next } });
  });
}

/** Move the caret without editing — the `select` backstop the primitive reads. */
async function caretTo(h: Harness, at: number): Promise<void> {
  const ta = h.ta();
  await act(async () => {
    ta.setSelectionRange(at, at);
    fireEvent.select(ta);
  });
}

/** Push `Date` past the coalesce window; timers stay real (see the header). */
function pause(ms = 800): void {
  vi.setSystemTime(new Date(Date.now() + ms));
}

const undo = (h: Harness) => act(async () => h.ctx().undo());
const redo = (h: Harness) => act(async () => h.ctx().redo());

// ---------------------------------------------------------------------------

describe("a block's plain-text surface records onto the document stack", () => {
  it("records the burst BEFORE any row write has fired", async () => {
    // The reported bug, stated directly. With a 60 s persist debounce nothing
    // can have reached the row — and the entry must already be there.
    const h = mount();
    await type(h, "c");
    await type(h, "co");
    await type(h, "con");

    expect(h.ta().value).toBe("con");
    expect(h.row()).toBe(""); // no write dispatched yet…
    expect(h.ctx().canUndo).toBe(true); // …and it is already undoable.

    await undo(h);
    expect(h.ta().value).toBe("");
  });

  it("one typing run is ONE entry", async () => {
    const h = mount();
    await type(h, "a");
    await type(h, "ab");
    await type(h, "abc");

    expect(h.ctx().canUndo).toBe(true);
    await undo(h);
    // The whole run, not one character.
    expect(h.ta().value).toBe("");
    expect(h.ctx().canUndo).toBe(false);

    await redo(h);
    expect(h.ta().value).toBe("abc");
  });

  it("a paste is ONE entry", async () => {
    const h = mount();
    await type(h, "x");
    pause();

    const ta = h.ta();
    await act(async () => {
      fireEvent.paste(ta);
      fireEvent.change(ta, {
        target: { value: "x\nconst a = 1;\nconst b = 2;" },
      });
    });
    expect(h.ta().value).toBe("x\nconst a = 1;\nconst b = 2;");

    // ONE Cmd+Z reverses the whole paste — the reported symptom, inverted.
    await undo(h);
    expect(h.ta().value).toBe("x");
    await redo(h);
    expect(h.ta().value).toBe("x\nconst a = 1;\nconst b = 2;");
  });

  it("a pause past the coalesce window starts a second entry", async () => {
    const h = mount();
    await type(h, "a");
    pause();
    await type(h, "ab");

    await undo(h);
    expect(h.ta().value).toBe("a");
    expect(h.ctx().canUndo).toBe(true);

    await undo(h);
    expect(h.ta().value).toBe("");
    expect(h.ctx().canUndo).toBe(false);
  });

  it("undo restores the visible value AND the selection, in the focused field", async () => {
    const h = mount();
    await type(h, "hello");
    // Put the caret mid-word and let the run close, so the next keystroke
    // starts an entry whose `undo` is pinned to THIS caret.
    await caretTo(h, 2);
    pause();
    await type(h, "heXllo");

    await undo(h);
    const ta = h.ta();
    expect(ta.value).toBe("hello");
    // `commitRow`'s `caretOffset` → `focusBlock` path only focuses a void
    // block; the selection is the primitive's own to put back.
    expect(document.activeElement).toBe(ta);
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 2]);
  });

  it("the row catches up on the debounce, and undo/redo write it too", async () => {
    const h = mount(10);
    await type(h, "let q");
    await waitFor(() => expect(h.row()).toBe("let q"));

    await undo(h);
    expect(h.ta().value).toBe("");
    expect(h.row()).toBe("");

    await redo(h);
    expect(h.ta().value).toBe("let q");
    expect(h.row()).toBe("let q");
  });

  it("the row-data recorder beside it never merges with a text entry", async () => {
    // Both recorders act on the same block, so the obvious coalesce key —
    // `blockId` — would let them merge inside the 500 ms window into one entry
    // whose `undo` reverts the LANGUAGE and whose `redo` restores the TEXT.
    // That is why the text key is namespaced.
    const h = mount();
    await act(async () =>
      fireEvent.click(screen.getByLabelText("set language")),
    );
    expect(h.language()).toBe("ts");

    await type(h, "z"); // …well inside the coalesce window.

    // Two entries, in order: the text first, then the language.
    await undo(h);
    expect(h.ta().value).toBe("");
    expect(h.language()).toBe("ts");

    expect(h.ctx().canUndo).toBe(true);
    await undo(h);
    expect(h.language()).toBeUndefined();
  });

  it("replaying does not record a second time", async () => {
    // The thunks commit the row as well as the draft. If that commit recorded,
    // one burst would cost two Cmd+Z — the first of them reverting the row
    // while the textarea kept showing its own draft, i.e. an undo that appears
    // to do nothing. `canUndo` going false on ONE undo is that assertion.
    const h = mount(10);
    await type(h, "one");
    await waitFor(() => expect(h.row()).toBe("one"));

    await undo(h);
    expect(h.ctx().canUndo).toBe(false);
    expect(h.ctx().canRedo).toBe(true);

    await redo(h);
    expect(h.ctx().canRedo).toBe(false);
    expect(h.ctx().canUndo).toBe(true);
    expect(h.ta().value).toBe("one");
  });
});
