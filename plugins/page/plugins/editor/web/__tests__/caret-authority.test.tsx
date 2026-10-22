// The long-window case, made deterministic.
//
// Typing "alpha" Enter "bravo" with no delay produced `["alphab", "ravo"]`: the
// block Enter creates does not exist yet, so the caret only landed when its
// editor's PASSIVE effect registered a focus handle — a separate React scheduler
// task — while keydowns arrive from the browser's higher-priority
// user-interaction source. Everything typed in that gap went to the ORIGIN.
//
// A real browser closes that gap in a millisecond or two on an idle box, so an
// e2e gate only ever proves the fast path. Here the gap is a variable: the
// target's handle is simply withheld until the test registers it, which is the
// SAME state a machine under load reaches — and the only place the slow path is
// deterministic. This file is therefore the primary guardrail for the caret
// authority; `e2e/split-typing-verify.ts` covers the fast path for real.
//
// ## Fidelity caveats
//
// - Like `structural-undo.test.tsx`, the harness mounts the PROVIDER only, with a
//   probe standing in for `BlockEditorInner` — it feeds `rowsRef`/`flatOrder` and
//   attaches the interaction surface, both of which the authority genuinely needs
//   (an unattached surface cannot claim a flight at all). Mounting the real
//   `<BlockEditor>` would need every block type registered plus Lexical and a Yjs
//   binding per row in a layout-less DOM.
// - Block handles are fakes registered straight through `registerFocusHandle`.
//   The fidelity that matters is the CONTRACT, not Lexical: `focus` reports the
//   landing through `opts.onLanded`, and `replayInput` receives the buffer. A
//   fake whose Enter creates a block is exactly what `KeyboardPlugin` does with a
//   replayed `KEY_ENTER_COMMAND`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { renderWithTransport } from "@plugins/primitives/plugins/networking/web/testing";
import { useEffect, useMemo, useRef, useState } from "react";
import { PluginProvider } from "@plugins/framework/plugins/web-sdk/core";
import { UndoRedoProvider } from "@plugins/primitives/plugins/undo-redo/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  planForestInsert,
  runsToXmlText,
  withMintedIds,
  type Block,
  type RichText,
  type SerializedBlock,
} from "../../core";
import {
  projectableRunsOf,
  type DocSourcedRuns,
} from "../internal/doc-sourced-runs";
import { fromNodes } from "../internal/optimistic-block-ops";
import { BlockEditorProvider, useBlockEditor } from "../block-editor-context";
import {
  caretFlightReportSink,
  type BlockFocusHandle,
  type CaretFlightAbortReport,
  type FlightInput,
} from "../internal/caret-authority";

const PAGE_ID = "page-1";
const TEXT = "page/text";

let uuidCounter = 0;
Object.defineProperty(globalThis.crypto, "randomUUID", {
  value: () => `id-${++uuidCounter}`,
  configurable: true,
  writable: true,
});

let reports: CaretFlightAbortReport[] = [];

beforeEach(() => {
  uuidCounter = 0;
  reports = [];
  caretFlightReportSink.register((r) => {
    reports.push(r);
  });
});
afterEach(() => {
  caretFlightReportSink.register(null);
  cleanup();
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

function seed(): Block[] {
  const forest: SerializedBlock[] = ["A", "B"].map((text) => ({
    type: TEXT,
    data: { text: [{ text }] },
    expanded: true,
    children: [],
  }));
  const { nodes } = planForestInsert({
    pageId: PAGE_ID,
    parentId: PAGE_ID,
    rootRanks: Rank.nBetween(null, null, forest.length),
    forest: withMintedIds(forest),
  });
  return fromNodes(nodes, []);
}

type Ctx = ReturnType<typeof useBlockEditor>;

/**
 * Stands in for `BlockEditorInner`: feeds the provider the rows every mutation
 * snapshots as its `before`, and hands the authority the focusable interaction
 * surface it parks the caret on while a landing is outstanding.
 */
function Probe({
  hidden,
  onCtx,
}: {
  /** Ids the surface renders NO line for — a collapsed ancestor, in one word. */
  hidden: readonly string[];
  onCtx: (ctx: Ctx, container: HTMLElement) => void;
}) {
  const ctx = useBlockEditor();
  const containerRef = useRef<HTMLDivElement>(null);
  const { blocks, setRows, setFlatOrder, attachContainer } = ctx;

  const rows = useMemo(
    () => [...blocks].sort((a, b) => Rank.compare(a.rank, b.rank)),
    [blocks],
  );
  // `rows` is every block; the flat order is only the VISIBLE lines — the same
  // split production has between `setRows` and `flattenTree`'s output.
  useEffect(() => {
    setFlatOrder(rows.filter((b) => !hidden.includes(b.id)));
    setRows(rows);
  }, [rows, hidden, setRows, setFlatOrder]);

  useEffect(() => {
    attachContainer(containerRef.current);
    return () => attachContainer(null);
  }, [attachContainer, containerRef]);

  // No dep array: publish after EVERY commit, so the sink always holds the
  // latest context (see `structural-undo.test.tsx`).
  useEffect(() => {
    if (containerRef.current) onCtx(ctx, containerRef.current);
  });

  return <div ref={containerRef} data-testid="container" tabIndex={-1} />;
}

/** What a fake block host received, and how it reacts to a replayed key. */
interface FakeBlock {
  id: string;
  /** Everything `replayInput` was handed, flattened in order. */
  received: FlightInput[];
  /** The buffered text this block ended up holding. */
  text: () => string;
  unregister: () => void;
}

function mount() {
  const sink: {
    ctx: Ctx | null;
    container: HTMLElement | null;
    hide: ((ids: string[]) => void) | null;
  } = { ctx: null, container: null, hide: null };
  const initialBlocks = seed();

  // The hidden set lives ABOVE the provider so changing it commits the provider
  // too — the same push the flight bound counts against. Its setter is published
  // through a CALLBACK, like `onCtx`: the write belongs to `mount`'s closure,
  // which owns the sink, not to this component's render.
  function Host({ onHide }: { onHide: (set: (ids: string[]) => void) => void }) {
    const [hidden, setHidden] = useState<string[]>([]);
    useEffect(() => {
      onHide(setHidden);
    }, [onHide]);
    return (
      <BlockEditorProvider pageId={PAGE_ID} persist={false} initialBlocks={initialBlocks}>
        <Probe
          hidden={hidden}
          onCtx={(ctx, container) => {
            sink.ctx = ctx;
            sink.container = container;
          }}
        />
      </BlockEditorProvider>
    );
  }

  renderWithTransport(
    <PluginProvider plugins={[]}>
      <UndoRedoProvider>
        <Host
          onHide={(set) => {
            sink.hide = set;
          }}
        />
      </UndoRedoProvider>
    </PluginProvider>,
  );
  const ctx = () => {
    if (!sink.ctx) throw new Error("provider never rendered its child");
    return sink.ctx;
  };
  const container = () => {
    if (!sink.container) throw new Error("container never attached");
    return sink.container;
  };

  /**
   * Mount a fake host for `id`. `onKey` is what the block does with a replayed
   * structural key — the real editor routes it through `resolveKeystroke`.
   *
   * `await`ed, like every other driver here: the authority defers each replay one
   * microtask (so it never runs inside an enclosing Lexical update), so a replay
   * has not happened yet when a synchronous `act` returns.
   */
  const register = async (
    id: string,
    onKey?: (key: string) => void,
    /**
     * Which half of the landing contract this fake honors. `"landed"` is the
     * ordinary surface; `"lost"` is the hydrating editor that took DOM focus and
     * then found focus gone by the time its content arrived — it must report the
     * abandonment, not simply return (see `focusHydratingAware`).
     */
    landing: "landed" | "lost" = "landed",
  ): Promise<FakeBlock> => {
    const received: FlightInput[] = [];
    const handle: BlockFocusHandle = {
      focus: (opts) =>
        landing === "landed" ? opts?.onLanded?.() : opts?.onLandingLost?.(),
      replayInput: (entries) => {
        for (const entry of entries) {
          received.push(entry);
          if (entry.kind === "key") onKey?.(entry.key);
        }
      },
    };
    let unregister = () => {};
    await act(async () => {
      unregister = ctx().registerFocusHandle(id, handle);
    });
    return {
      id,
      received,
      text: () =>
        received
          .filter((e): e is { kind: "text"; text: string } => e.kind === "text")
          .map((e) => e.text)
          .join(""),
      unregister,
    };
  };

  let projections = 0;
  return {
    ctx,
    container,
    register,
    /** The id of the seeded block whose text is `text`. */
    id: (text: string) => {
      const found = initialBlocks.find(
        (b) => (b.data as { text: { text: string }[] }).text[0]?.text === text,
      );
      if (!found) throw new Error(`no seeded block "${text}"`);
      return found.id;
    },
    /**
     * Force one commit through the provider — the push-based signal the flight
     * bound counts against. A row write is the honest way to produce one: the
     * provider re-renders because the DOCUMENT changed.
     */
    commit: async (blockId: string) => {
      await act(async () =>
        ctx().projectText(blockId, docRuns([{ text: `x${++projections}` }])),
      );
    },
    /** Stop the surface from rendering a line for `ids` (a collapsed ancestor). */
    hide: async (ids: string[]) => {
      await act(async () => sink.hide?.(ids));
    },
  };
}

/** Type into the surface the way a browser does while no editing host is focused. */
function type(el: HTMLElement, text: string): void {
  for (const ch of text) fireEvent.keyDown(el, { key: ch });
}

// ---------------------------------------------------------------------------

describe("input follows the model caret, not the DOM", () => {
  it("buffers everything typed before the new block's host mounts, in order", async () => {
    const t = mount();
    const originId = t.id("B");
    const origin = await t.register(originId);
    await act(async () => t.ctx().makeBlockAPI(originId).onFocus());

    // Enter: the new block's id is minted here, its editor is not mounted yet.
    let targetId = "";
    await act(async () => {
      targetId = t.ctx().makeBlockAPI(originId).insertAfter(TEXT, { text: [] });
    });

    type(t.container(), "alpha");

    // THE regression: not one character reached the block the caret left.
    expect(origin.received).toEqual([]);

    const target = await t.register(targetId);
    expect(target.text()).toBe("alpha");
  });

  it("a replayed Enter claims the next flight, and later input follows it there", async () => {
    const t = mount();
    const originId = t.id("B");
    const origin = await t.register(originId);
    await act(async () => t.ctx().makeBlockAPI(originId).onFocus());

    let firstId = "";
    await act(async () => {
      firstId = t.ctx().makeBlockAPI(originId).insertAfter(TEXT, { text: [] });
    });

    // The exact repro, with the whole burst landing inside the mount gap.
    type(t.container(), "alpha");
    fireEvent.keyDown(t.container(), { key: "Enter" });
    type(t.container(), "bravo");

    expect(origin.received).toEqual([]);

    // The first block's host finally mounts. Its replayed Enter splits again —
    // which is where the SECOND block is minted, mid-replay.
    let secondId = "";
    const first = await t.register(firstId, (key) => {
      if (key === "Enter") secondId = t.ctx().makeBlockAPI(firstId).insertAfter(TEXT, { text: [] });
    });

    expect(first.text()).toBe("alpha");
    expect(secondId).not.toBe("");

    // "bravo" was handed to the flight the Enter claimed, not to the block the
    // Enter left — the composition that used to leave a character behind.
    const second = await t.register(secondId);
    expect(second.text()).toBe("bravo");
    expect(first.text()).toBe("alpha");
  });

  // The converse ordering: the key comes FIRST, so the hand-off in `claim()` is
  // exercised with an empty target buffer. Nothing may be inserted into the block
  // the Enter left — its whole buffer belongs to the flight the Enter claimed.
  it("hands a buffer that STARTS with a key to the flight that key claims", async () => {
    const t = mount();
    const originId = t.id("B");
    await t.register(originId);
    await act(async () => t.ctx().makeBlockAPI(originId).onFocus());

    let firstId = "";
    await act(async () => {
      firstId = t.ctx().makeBlockAPI(originId).insertAfter(TEXT, { text: [] });
    });

    fireEvent.keyDown(t.container(), { key: "Enter" });
    type(t.container(), "bravo");

    let secondId = "";
    const first = await t.register(firstId, (key) => {
      if (key === "Enter") secondId = t.ctx().makeBlockAPI(firstId).insertAfter(TEXT, { text: [] });
    });

    expect(first.text()).toBe("");
    expect(secondId).not.toBe("");
    const second = await t.register(secondId);
    expect(second.text()).toBe("bravo");
  });

  it("lets Ctrl/Cmd-modified keydowns through untouched while in flight", async () => {
    const t = mount();
    const originId = t.id("B");
    await t.register(originId);
    await act(async () => t.ctx().makeBlockAPI(originId).onFocus());

    let targetId = "";
    await act(async () => {
      targetId = t.ctx().makeBlockAPI(originId).insertAfter(TEXT, { text: [] });
    });

    type(t.container(), "a");
    // `fireEvent` returns false when a listener called `preventDefault` — so this
    // asserts the shortcut reached the rest of the app (Cmd+Z, clipboard, …).
    expect(fireEvent.keyDown(t.container(), { key: "z", metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(t.container(), { key: "b", ctrlKey: true })).toBe(true);
    // …while an ordinary character IS consumed by the authority.
    expect(fireEvent.keyDown(t.container(), { key: "b" })).toBe(false);

    const target = await t.register(targetId);
    expect(target.text()).toBe("ab");
  });
});

describe("a failed landing is a state, not a silence", () => {
  it("replays the buffer into the origin and reports once", async () => {
    const t = mount();
    const originId = t.id("B");
    const origin = await t.register(originId);
    await act(async () => t.ctx().makeBlockAPI(originId).onFocus());

    // A landing claimed for a block no authoritative snapshot ever contains —
    // what an op the reducer refused leaves behind.
    await act(async () => t.ctx().focusBlock("never-created"));
    type(t.container(), "hi");
    expect(origin.received).toEqual([]);

    await t.commit(originId);
    await t.commit(originId);

    expect(origin.text()).toBe("hi");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      reason: "target-never-rendered",
      targetId: "never-created",
      originId,
      buffered: 2,
      replayedInto: originId,
    });

    // The keyboard is released: further typing is no longer captured.
    expect(fireEvent.keyDown(t.container(), { key: "x" })).toBe(true);
    expect(origin.text()).toBe("hi");
  });

  // The row EXISTS, so a bound drawn on row existence would hold the flight open
  // forever and swallow the keyboard with no diagnosis — worse than the bug this
  // whole mechanism fixes, which at least left the characters visible somewhere.
  // Bounding on what the surface RENDERS names the state instead.
  it("aborts when the target's row exists but no line is ever rendered for it", async () => {
    const t = mount();
    const originId = t.id("B");
    const origin = await t.register(originId);
    await act(async () => t.ctx().makeBlockAPI(originId).onFocus());

    let targetId = "";
    await act(async () => {
      targetId = t.ctx().makeBlockAPI(originId).insertAfter(TEXT, { text: [] });
    });
    type(t.container(), "hi");

    // The block landed somewhere unrenderable (a collapsed ancestor): its row is
    // in the document, but the flatten emits no line for it, so no editor will
    // ever mount and `registerFocusHandle` will never fire.
    await t.hide([targetId]);
    await t.commit(originId);

    expect(origin.text()).toBe("hi");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reason: "target-never-rendered", targetId });
    expect(fireEvent.keyDown(t.container(), { key: "x" })).toBe(true);
  });

  // Neither of the authority's own bounds can see this one: the target IS
  // rendered (so `reconcile` never trips) and focus never left the block list
  // (so `focusout` never fires). Without the surface reporting the loss, the
  // flight is permanent — the keyboard stays held and the user types into
  // nothing, which is strictly worse than the misrouting the authority exists to
  // fix. So a surface that abandons a landing MUST say so.
  it("aborts when the target's own landing policy reports the landing lost", async () => {
    const t = mount();
    const originId = t.id("B");
    const origin = await t.register(originId);
    await act(async () => t.ctx().makeBlockAPI(originId).onFocus());

    let targetId = "";
    await act(async () => {
      targetId = t.ctx().makeBlockAPI(originId).insertAfter(TEXT, { text: [] });
    });
    type(t.container(), "hi");
    expect(origin.received).toEqual([]);

    // The target mounts — and its hydrating landing gives up (focus moved off
    // its root before the content doc arrived).
    await t.register(targetId, undefined, "lost");

    expect(origin.text()).toBe("hi");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      reason: "landing-focus-lost",
      targetId,
      originId,
      buffered: 2,
      replayedInto: originId,
    });
    // The keyboard is released rather than held forever.
    expect(fireEvent.keyDown(t.container(), { key: "x" })).toBe(true);
  });

  it("does not report a landing that succeeds", async () => {
    const t = mount();
    const originId = t.id("B");
    await t.register(originId);
    await act(async () => t.ctx().makeBlockAPI(originId).onFocus());

    let targetId = "";
    await act(async () => {
      targetId = t.ctx().makeBlockAPI(originId).insertAfter(TEXT, { text: [] });
    });
    type(t.container(), "ok");
    await t.commit(originId);
    await t.commit(originId);
    const target = await t.register(targetId);

    expect(target.text()).toBe("ok");
    expect(reports).toEqual([]);
  });
});
