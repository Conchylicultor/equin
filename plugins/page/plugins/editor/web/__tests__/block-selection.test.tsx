import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useEffect, useMemo, useRef } from "react";
import {
  MultiSelectProvider,
  useMultiSelect,
} from "@plugins/primitives/plugins/multi-select/web";
import { announce } from "@plugins/primitives/plugins/announce/web";
import {
  SelectionControlProvider,
  useSelectionControl,
} from "../selection-control";
import {
  useBlockSelection,
  BLOCK_LIST_ARIA,
  type BlockSelectionActions,
  type TextSpan,
} from "../internal/use-block-selection";
import type { VisibleBlock } from "../internal/selection-closure";
import type { SpanMotion } from "../internal/span-motion";
import type { SpanSelection } from "../../core";

// The announcement channel is a module-level writer into a page-global live
// region, so the way to observe it from a hook test is to own the module — the
// same isolation idiom the editor's collab tests use for their side-effecting
// modules. Mounting the real host would test the announcer, not this hook.
vi.mock("@plugins/primitives/plugins/announce/web", () => ({
  announce: vi.fn(),
}));

const announced = vi.mocked(announce);

afterEach(cleanup);
beforeEach(() => announced.mockClear());

const IDS = ["b1", "b2", "b3", "b4"] as const;

/**
 * The default harness list: four blocks, all at the top level. Depth is what
 * decides whether a range takes further rows with it, so a FLAT list is what
 * isolates the focus/keyboard rules below from the descendant closure — the
 * nested list has its own describe block at the end.
 */
const FLAT: VisibleBlock[] = IDS.map((id) => ({ id, depth: 0 }));

/**
 * The reported shape: `b1` with two children, then a top-level `b4`.
 *
 *   b1
 *     b2
 *     b3
 *   b4
 */
const NESTED: VisibleBlock[] = [
  { id: "b1", depth: 0 },
  { id: "b2", depth: 1 },
  { id: "b3", depth: 1 },
  { id: "b4", depth: 0 },
];

/** What the last `extendSpan` click answered (the executor's "claimed?"). */
let extendResult: boolean | undefined;

/** What the harness's blocks are called when the selection speaks their name. */
const describeBlock = (id: string) => `Text: ${id} body`;

/** A span drawn UPWARD from mid-`b3` to mid-`b2`, as `normalizeSpan` returns it. */
const SPAN: TextSpan = {
  kind: "text",
  anchor: { blockId: "b3", offset: 2 },
  head: { blockId: "b2", offset: 1 },
  from: { blockId: "b2", offset: 1 },
  to: { blockId: "b3", offset: 2 },
};

/** Every announcement made since the last reset, in order. */
const spoken = () => announced.mock.calls.map(([message]) => message);

/**
 * Stands in for a block's Lexical text editor. The fidelity that matters is the
 * SHAPE of the dispatch, not the editor: `KeyboardPlugin` reaches
 * `enterSelectionMode` from a Lexical command, which Lexical dispatches from its
 * own NATIVE keydown listener on the block's `contenteditable`. So this listener
 * is native (not a React prop), runs before React's delegated root listener, and
 * moves DOM focus to the container mid-dispatch — leaving the still-bubbling
 * keydown to reach the container while `document.activeElement` already points at
 * it. That is the trap the origin guard exists for.
 */
function FakeBlockEditor({ id }: { id: string }) {
  const control = useSelectionControl();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !control) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        control.enterSelectionMode(id);
      } else if (e.key === "ArrowUp" && e.shiftKey) {
        e.preventDefault();
        control.enterSelectionMode(id, "up");
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [control, id]);

  return (
    <div
      ref={ref}
      data-testid={`block-${id}`}
      contentEditable
      suppressContentEditableWarning
      tabIndex={0}
    />
  );
}

/** The real `useBlockSelection`, wired to the real `MultiSelectProvider`. */
function Surface({
  actions,
  visible,
}: {
  actions: BlockSelectionActions;
  visible: VisibleBlock[];
}) {
  const { selectedIds, selectedCount } = useMultiSelect();
  // The editor derives the roots from the block forest, which this harness does
  // not have — so it names every selected block. Only the indent/outdent
  // assertions read them, and those run on the flat list, where every selected
  // block IS its own root. `selected` below therefore doubles as a readout of
  // the whole selection, which is what the closure tests assert on.
  const roots = useMemo(() => [...selectedIds], [selectedIds]);

  const {
    containerRef,
    control,
    clearSelection,
    onKeyDown,
    onFocusCapture,
    textSpan,
    setTextSpan,
  } = useBlockSelection({
    visible,
    roots,
    focusedBlockId: null,
    describeBlock,
    actions,
  });

  return (
    <>
      <div data-testid="count">{selectedCount}</div>
      <div data-testid="selected">{roots.join(",")}</div>
      {/* The editor clears imperatively too (the selection bar's Delete, the
          caret going back into a block), so a clear that reaches the hook while
          nothing is selected is a real path, not a contrived one. */}
      <button data-testid="clear" type="button" onClick={clearSelection} />
      {/* Stand in for the keyboard plugin's `extendSpan` executor: Shift+Down
          on b2's last line with the native anchor at 3, and Shift+Up on the
          first line of the first block. */}
      <button
        data-testid="extend-b2"
        type="button"
        onClick={() => {
          extendResult = control.extendSpan("b2", 3, "down", 0);
        }}
      />
      <button
        data-testid="extend-b3"
        type="button"
        onClick={() => {
          extendResult = control.extendSpan("b3", 2, "down", 0);
        }}
      />
      <button
        data-testid="extend-b1-up"
        type="button"
        onClick={() => {
          extendResult = control.extendSpan("b1", 0, "up", 0);
        }}
      />
      {/* Stands in for the pointer gesture that builds a span (block-editor's
          promotion); the span itself is what `normalizeSpan` would hand it. */}
      <button
        data-testid="span"
        type="button"
        onClick={() => setTextSpan(SPAN)}
      />
      <div data-testid="text-span">
        {textSpan
          ? `${textSpan.from.blockId}:${textSpan.from.offset}-${textSpan.to.blockId}:${textSpan.to.offset}`
          : ""}
      </div>
      {/* The editor's own container ARIA, from the one value the real surface
          spreads too — so the role assertions below test what the block list
          actually claims to be, not what this harness happened to type. */}
      <div
        data-testid="container"
        ref={containerRef}
        tabIndex={-1}
        {...BLOCK_LIST_ARIA}
        onKeyDown={onKeyDown}
        onFocusCapture={onFocusCapture}
      >
        <SelectionControlProvider value={control}>
          {visible.map((v) => (
            <FakeBlockEditor key={v.id} id={v.id} />
          ))}
        </SelectionControlProvider>
      </div>
    </>
  );
}

/**
 * A stand-in for the surface's span motion: every block holds five
 * characters, laid out one line each, except `b4`, which has no text — so a
 * span reaching it widens to blocks, as `normalizeSpan` does for a text-less
 * line. Enough geometry for the hook's keyboard policy; the real motion's
 * geometry is the e2e's (`e2e/cross-block-span-verify.ts`).
 */
const LEN = 5;
const ORDER = IDS as readonly string[];
const fakeSpanMotion: SpanMotion = {
  enter: (blockId, dir) => {
    const i =
      ORDER.indexOf(blockId) + (dir === "up" || dir === "left" ? -1 : 1);
    const next = ORDER[i];
    if (next === undefined) return null;
    return { blockId: next, offset: dir === "left" || dir === "up" ? LEN : 0 };
  },
  step: (head, dir) => {
    const back = dir === "left" || dir === "up";
    const offset = head.offset + (back ? -1 : 1);
    if (offset >= 0 && offset <= LEN)
      return { head: { ...head, offset }, x: 7 };
    const next = ORDER[ORDER.indexOf(head.blockId) + (back ? -1 : 1)];
    if (next === undefined) return null;
    return { head: { blockId: next, offset: back ? LEN : 0 }, x: 7 };
  },
  normalize: (anchor, head): SpanSelection => {
    if (anchor.blockId === "b4" || head.blockId === "b4")
      return { kind: "blocks", anchor: anchor.blockId, head: head.blockId };
    const a = ORDER.indexOf(anchor.blockId);
    const h = ORDER.indexOf(head.blockId);
    const forward = a < h || (a === h && anchor.offset <= head.offset);
    return {
      kind: "text",
      anchor,
      head,
      from: forward ? anchor : head,
      to: forward ? head : anchor,
    };
  },
};

function setup(visible: VisibleBlock[] = FLAT) {
  const actions: BlockSelectionActions = {
    spanMotion: fakeSpanMotion,
    indent: vi.fn(),
    outdent: vi.fn(),
    remove: vi.fn(),
    duplicate: vi.fn(),
    focusBlock: vi.fn(),
    moveSelection: vi.fn(),
    deleteSpan: vi.fn(),
  };
  const view = render(
    <MultiSelectProvider orderedIds={visible.map((v) => v.id)}>
      <Surface actions={actions} visible={visible} />
    </MultiSelectProvider>,
  );
  const el = (id: string) => view.getByTestId(id);
  return {
    view,
    actions,
    container: el("container"),
    clear: el("clear"),
    block: (id: string) => el(`block-${id}`),
    count: () => Number(el("count").textContent),
    span: () => el("text-span").textContent,
    makeSpan: () => fireEvent.click(el("span")),
    selected: () => el("selected").textContent,
  };
}

/**
 * Enter selection mode the way the editor does: a keydown consumed by the block's
 * own native listener, which applies the range and focuses the container.
 *
 * Afterwards the harness sits in exactly the state a real browser reaches
 * MID-DISPATCH on any block keystroke — `document.activeElement` is the container
 * and a selection is live — which is what makes the buggy `activeElement` guard
 * claim keys it never owned.
 *
 * jsdom cannot reproduce that state WITHIN one dispatch: React schedules the
 * reducer update on a microtask that cannot run while the synchronous dispatch is
 * still unwinding, so the container's stale closure bails at `!isActive` before
 * the bad guard can do damage. A real browser re-renders in time (`focusin` is
 * discrete) and the guard fires. Reaching the same state across two keystrokes
 * gives the same discrimination without depending on React's flush timing;
 * `e2e/block-selection-verify.ts` covers the single-dispatch symptom for real.
 */
function inSelectionMode(id: string, visible: VisibleBlock[] = FLAT) {
  const t = setup(visible);
  t.block(id).focus();
  fireEvent.keyDown(t.block(id), { key: "Escape" });
  return t;
}

describe("block-selection mode entry points", () => {
  it("Escape inside a block selects that block and focuses the container", () => {
    const t = inSelectionMode("b2");

    expect(t.count()).toBe(1);
    expect(t.selected()).toBe("b2");
    expect(document.activeElement).toBe(t.container);
  });

  // The reported bug, in the state jsdom can reach: an `activeElement`-guarded
  // handler claims the Escape the block just consumed, and clears the selection
  // that Escape created.
  it("Escape in another block re-selects it instead of clearing", () => {
    const t = inSelectionMode("b2");

    fireEvent.keyDown(t.block("b4"), { key: "Escape" });

    expect(t.count()).toBe(1);
    expect(t.selected()).toBe("b4");
  });

  // Same double-handling, different key: the container's own `ArrowUp + shift`
  // branch would extend the range a SECOND time off the one keypress (3 blocks).
  it("Shift+ArrowUp at a block edge extends by exactly one block", () => {
    const t = inSelectionMode("b2");

    fireEvent.keyDown(t.block("b3"), { key: "ArrowUp", shiftKey: true });

    expect(t.count()).toBe(2);
    expect(t.selected()).toBe("b2,b3");
  });

  // The branch the origin guard must NOT break: once the container itself holds
  // the caret, Escape is its own and clears the selection.
  it("Escape on the focused container clears the selection", () => {
    const t = inSelectionMode("b2");

    fireEvent.keyDown(t.container, { key: "Escape" });

    expect(t.count()).toBe(0);
  });

  // Focusing back into a block's editor drops the selection — but only because
  // the focus event's target is the block, not the container.
  it("focusing a block's editor drops the selection", () => {
    const t = inSelectionMode("b2");

    fireEvent.focus(t.block("b3"));

    expect(t.count()).toBe(0);
  });

  // Keys typed into a block editor are never the container's, even while a
  // selection is live (the container is an ancestor, so they bubble through it).
  it("keys targeted at a block editor never reach the container handler", () => {
    const t = inSelectionMode("b2");

    fireEvent.keyDown(t.block("b4"), { key: "Backspace" });
    fireEvent.keyDown(t.block("b4"), { key: "Tab" });

    expect(t.actions.remove).not.toHaveBeenCalled();
    expect(t.actions.indent).not.toHaveBeenCalled();
    expect(t.count()).toBe(1);
  });
});

describe("block-selection mode keyboard", () => {
  it("Tab / Shift+Tab indent and outdent the selection roots", () => {
    const t = inSelectionMode("b2");

    fireEvent.keyDown(t.container, { key: "Tab" });
    expect(t.actions.indent).toHaveBeenCalledWith(["b2"]);

    fireEvent.keyDown(t.container, { key: "Tab", shiftKey: true });
    expect(t.actions.outdent).toHaveBeenCalledWith(["b2"]);
  });

  it("Arrow moves the single selection, Shift+Arrow extends it", () => {
    const t = inSelectionMode("b2");

    fireEvent.keyDown(t.container, { key: "ArrowDown" });
    expect(t.selected()).toBe("b3");
    expect(t.count()).toBe(1);

    fireEvent.keyDown(t.container, { key: "ArrowDown", shiftKey: true });
    expect(t.selected()).toBe("b3,b4");
  });

  it("Alt+Shift+Arrow nudges the selection instead of extending it", () => {
    const t = inSelectionMode("b2");

    fireEvent.keyDown(t.container, {
      key: "ArrowDown",
      altKey: true,
      shiftKey: true,
    });

    expect(t.actions.moveSelection).toHaveBeenCalledWith("down");
    expect(t.selected()).toBe("b2");
  });

  it("Backspace deletes the selection and leaves selection mode", () => {
    const t = inSelectionMode("b2");

    fireEvent.keyDown(t.container, { key: "Backspace" });

    expect(t.actions.remove).toHaveBeenCalledWith(["b2"]);
    expect(t.count()).toBe(0);
  });

  it("Enter puts the caret back into the head block", () => {
    const t = inSelectionMode("b2");

    fireEvent.keyDown(t.container, { key: "Enter" });

    expect(t.actions.focusBlock).toHaveBeenCalledWith("b2");
    expect(t.count()).toBe(0);
  });

  it("Cmd+A selects every block, Cmd+D duplicates the selection", () => {
    const t = inSelectionMode("b2");

    fireEvent.keyDown(t.container, { key: "a", metaKey: true });
    expect(t.count()).toBe(IDS.length);

    fireEvent.keyDown(t.container, { key: "d", metaKey: true });
    expect(t.actions.duplicate).toHaveBeenCalledWith([...IDS]);
  });
});

// The block list is a group of editing hosts, not a listbox of options — so the
// selection has no `aria-selected` to live in and is SPOKEN instead. These are
// the two halves of that: what the container claims to be, and what it says.
describe("the block list is a document, not a listbox", () => {
  it("is a named group, and nothing in it is a listbox", () => {
    const t = setup();

    expect(t.view.getByRole("group", { name: "Page blocks" })).toBe(
      t.container,
    );
    expect(t.view.queryAllByRole("listbox")).toHaveLength(0);
    expect(t.view.queryAllByRole("option")).toHaveLength(0);
  });

  it("entering selection mode names the block and its position", () => {
    inSelectionMode("b2");

    expect(spoken()).toEqual(["Text: b2 body, block 2 of 4, selected"]);
  });

  it("extending the range says how many blocks it now covers", () => {
    const t = inSelectionMode("b2");
    announced.mockClear();

    fireEvent.keyDown(t.container, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(t.container, { key: "ArrowDown", shiftKey: true });

    expect(spoken()).toEqual([
      "Text: b3 body, block 3 of 4, 2 blocks selected",
      "Text: b4 body, block 4 of 4, 3 blocks selected",
    ]);
  });

  it("moving the single selection re-announces the new block alone", () => {
    const t = inSelectionMode("b2");
    announced.mockClear();

    fireEvent.keyDown(t.container, { key: "ArrowDown" });

    expect(spoken()).toEqual(["Text: b3 body, block 3 of 4, selected"]);
  });

  // A marquee drag re-applies the same range once per pointermove; the reducer
  // already bails on that, and so must the speech.
  it("re-applying the same range says nothing a second time", () => {
    const t = inSelectionMode("b2");
    announced.mockClear();

    fireEvent.keyDown(t.block("b2"), { key: "Escape" });

    expect(spoken()).toEqual([]);
  });

  it("Cmd+A announces the whole document instead of one block", () => {
    const t = inSelectionMode("b2");
    announced.mockClear();

    fireEvent.keyDown(t.container, { key: "a", metaKey: true });

    expect(spoken()).toEqual(["All 4 blocks selected"]);
  });

  it("Escape on the container announces the clear", () => {
    const t = inSelectionMode("b2");
    announced.mockClear();

    fireEvent.keyDown(t.container, { key: "Escape" });

    expect(spoken()).toEqual(["Selection cleared"]);
  });

  // The focus-out clear and the post-delete clear both land on an already-empty
  // selection. "Selection cleared" over nothing is a sentence about nothing.
  it("clearing an empty selection announces nothing", () => {
    const t = setup();

    fireEvent.click(t.clear);
    expect(spoken()).toEqual([]);

    fireEvent.keyDown(t.block("b2"), { key: "Escape" });
    announced.mockClear();

    fireEvent.click(t.clear);
    fireEvent.click(t.clear);
    expect(spoken()).toEqual(["Selection cleared"]);
  });
});

/**
 * A block's children go where it goes — every structural op acts on the
 * selection's subtree roots, and a root carries its subtree — so a range that
 * names a parent names its children too. The bug this closes: selecting `b1`
 * and `b2` and pressing Backspace deleted `b3` as well, which the selection
 * never showed.
 */
describe("a selected block brings its children with it", () => {
  it("selecting a parent selects its whole subtree", () => {
    const t = inSelectionMode("b1", NESTED);

    expect(t.selected()).toBe("b1,b2,b3");
    expect(t.count()).toBe(3);
  });

  it("what Backspace deletes is what the selection showed", () => {
    const t = inSelectionMode("b1", NESTED);

    fireEvent.keyDown(t.container, { key: "Backspace" });

    expect(t.actions.remove).toHaveBeenCalledWith(["b1", "b2", "b3"]);
  });

  it("extending onto a child leaves the rest of the subtree in", () => {
    const t = inSelectionMode("b1", NESTED);

    // Shrinking below the subtree is not available, and should not be: `b1` is
    // selected, so `b3` is selected.
    fireEvent.keyDown(t.container, { key: "ArrowUp", shiftKey: true });

    expect(t.selected()).toBe("b1,b2,b3");
  });

  it("a child alone does not select its parent or its siblings", () => {
    const t = inSelectionMode("b2", NESTED);

    expect(t.selected()).toBe("b2");
  });

  it("Shift+ArrowDown extends past the children, not back into them", () => {
    const t = inSelectionMode("b1", NESTED);

    fireEvent.keyDown(t.container, { key: "ArrowDown", shiftKey: true });

    expect(t.selected()).toBe("b1,b2,b3,b4");
  });

  it("ArrowDown steps off the end of the subtree", () => {
    const t = inSelectionMode("b1", NESTED);

    fireEvent.keyDown(t.container, { key: "ArrowDown" });

    expect(t.selected()).toBe("b4");
  });

  it("Enter returns the caret to the block the user was on", () => {
    const t = inSelectionMode("b1", NESTED);

    fireEvent.keyDown(t.container, { key: "Enter" });

    // The parent, not the last child the closure swept in.
    expect(t.actions.focusBlock).toHaveBeenCalledWith("b1");
  });

  it("names the block the user aimed at, and counts what is selected", () => {
    inSelectionMode("b1", NESTED);

    expect(spoken()).toEqual([
      "Text: b1 body, block 1 of 4, 3 blocks selected",
    ]);
  });
});

/**
 * The selection is a union — nothing, a block range, or an editor-owned text
 * span — and each arm's setter retires the other.
 */
describe("the selection union: a text span", () => {
  it("a span holds the keyboard on the container and selects no block", () => {
    const t = setup();
    t.makeSpan();

    expect(t.span()).toBe("b2:1-b3:2");
    expect(t.count()).toBe(0);
    expect(document.activeElement).toBe(t.container);
    expect(spoken()).toEqual(["Text selected"]);
  });

  it("Escape climbs to the blocks the span touches", () => {
    const t = setup();
    t.makeSpan();

    fireEvent.keyDown(t.container, { key: "Escape" });

    expect(t.span()).toBe("");
    expect(t.selected()).toBe("b2,b3");
  });

  it("Delete deletes the span's ordered ends and leaves span mode", () => {
    const t = setup();
    t.makeSpan();

    fireEvent.keyDown(t.container, { key: "Delete" });

    expect(t.actions.deleteSpan).toHaveBeenCalledWith(SPAN.from, SPAN.to);
    expect(t.actions.remove).not.toHaveBeenCalled();
    expect(t.span()).toBe("");
  });

  it("a plain arrow collapses the span to the end it points at", () => {
    const t = setup();
    t.makeSpan();

    fireEvent.keyDown(t.container, { key: "ArrowRight" });

    expect(t.actions.focusBlock).toHaveBeenCalledWith("b3", 2);
    expect(t.span()).toBe("");
  });

  it("a block range replaces the span, and a span replaces the range", () => {
    const t = inSelectionMode("b1");
    t.makeSpan();
    expect(t.count()).toBe(0);
    expect(t.span()).toBe("b2:1-b3:2");

    fireEvent.keyDown(t.block("b4"), { key: "Escape" });
    expect(t.span()).toBe("");
    expect(t.selected()).toBe("b4");
  });

  it("focusing into a block drops the span", () => {
    const t = setup();
    t.makeSpan();

    fireEvent.focus(t.block("b1"));

    expect(t.span()).toBe("");
  });

  it("a printable key types OVER the span: deleted, the key replayed at the join", () => {
    const t = setup();
    t.makeSpan();

    fireEvent.keyDown(t.container, { key: "x" });

    expect(t.actions.deleteSpan).toHaveBeenCalledWith(SPAN.from, SPAN.to, [
      { kind: "text", text: "x" },
    ]);
    expect(t.span()).toBe("");
  });

  it("Enter types over the span as a key (it splits at the join)", () => {
    const t = setup();
    t.makeSpan();

    fireEvent.keyDown(t.container, { key: "Enter" });

    expect(t.actions.deleteSpan).toHaveBeenCalledWith(SPAN.from, SPAN.to, [
      { kind: "key", key: "Enter", shift: false },
    ]);
  });

  it("a shortcut is not typing: Cmd+B leaves the span alone", () => {
    const t = setup();
    t.makeSpan();

    fireEvent.keyDown(t.container, { key: "b", metaKey: true });

    expect(t.actions.deleteSpan).not.toHaveBeenCalled();
    expect(t.span()).toBe("b2:1-b3:2");
  });

  it("Shift+Arrow moves the HEAD, keeping the anchor", () => {
    const t = setup();
    t.makeSpan();

    // The span was drawn upward: anchor b3:2, head b2:1. Shift+Left grows it.
    fireEvent.keyDown(t.container, { key: "ArrowLeft", shiftKey: true });
    expect(t.span()).toBe("b2:0-b3:2");
    // …and across the line's edge into the line above.
    fireEvent.keyDown(t.container, { key: "ArrowLeft", shiftKey: true });
    expect(t.span()).toBe("b1:5-b3:2");
  });

  it("a head stepping back onto its anchor is a caret again", () => {
    const t = setup();
    t.makeSpan();
    // b2:1 → b2:5 is 4 steps, the line break 1, b3:0 → b3:2 2: seven.
    for (let i = 0; i < 7; i += 1)
      fireEvent.keyDown(t.container, { key: "ArrowRight", shiftKey: true });

    expect(t.span()).toBe("");
    expect(t.actions.focusBlock).toHaveBeenLastCalledWith("b3", 2);
  });
});

describe("Shift+Arrow out of a block's text draws a span", () => {
  it("anchored where the native selection was, its head in the next line", () => {
    const t = setup();
    // The keyboard plugin's `extendSpan` executor, called through the control.
    fireEvent.click(t.view.getByTestId("extend-b2"));
    expect(extendResult).toBe(true);
    expect(t.span()).toBe("b2:3-b3:0");
    expect(document.activeElement).toBe(t.container);
  });

  it("widens to blocks when the next line cannot end a span", () => {
    const t = setup();
    fireEvent.click(t.view.getByTestId("extend-b3"));
    expect(extendResult).toBe(true);
    expect(t.span()).toBe("");
    expect(t.selected()).toBe("b3,b4");
  });

  it("is not claimed when there is no line that way", () => {
    const t = setup();
    fireEvent.click(t.view.getByTestId("extend-b1-up"));
    expect(extendResult).toBe(false);
    expect(t.span()).toBe("");
  });
});
