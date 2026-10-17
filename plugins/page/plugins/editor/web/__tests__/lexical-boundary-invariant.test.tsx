// The library fact the whole mark-boundary design rests on, pinned as a test.
//
// The page editor models an inline-mark boundary as a caret position that DOES
// NOT EXIST in the document: the two sides of the seam are one address, so the
// caret's second component ("which side am I on") has to live in a side store
// (`web/internal/mark-depth.ts`). Design:
// `research/2026-08-06-page-inline-mark-boundary-caret.md`, and the arrival
// channel built on it: `research/2026-08-08-global-caret-crossing-channel.md`.
//
// ## It is LEXICAL that collapses the two sides, not Chromium
//
// `page/editor/CLAUDE.md` and the 2026-08-06 doc both attribute the collapse to
// the browser ("**Measured**: Chromium resolves a text/text seam to the END of
// the left run"). Same observable, wrong cause — and the difference matters,
// because a browser quirk could flip on the next Chromium release while a
// library invariant cannot flip without a version bump.
//
// The mechanism is `resolveSelectionPointOnBoundary` in `lexical@0.44.0`
// (`~/.bun/install/cache/lexical@0.44.0@@@1/Lexical.dev.mjs:7669-7677`). For a
// COLLAPSED point at `offset === 0` whose previous sibling is a `TextNode`, it
// does `point.set(prevSibling.__key, prevSibling.getTextContent().length,
// 'text')` — with no format check whatsoever. It is reached from
// `$normalizeSelectionPointsForBoundaries` (`:7701`) inside
// `$internalResolveSelectionPoints` (`:7743`), i.e. on EVERY DOM→model
// resolution. No browser is involved, which is why this test can run headless in
// jsdom and still be the real thing.
//
// The two tests below are the two halves of one statement:
//
//  1. Two adjacent `TextNode`s, the first carrying the `code` format bit. Hand
//     the resolver `(plainTextDOM, 0)` and it comes back `(codeLeaf, 2)` — the
//     right run's own start is not an address a caret can hold.
//     **If this ever fails, the mark-boundary design's central premise has
//     changed: `(rightLeaf, 0)` is now a real, holdable position, and
//     `web/internal/mark-depth.ts` (plus the arrival channel that feeds it) must
//     be revisited rather than patched.**
//
//  2. The same shape with a `LinkNode` — a real inline `ElementNode`, registered
//     in the page editor today — in place of the code-formatted run. The anchor
//     comes back `(plainLeaf, 0)` UNCHANGED, because the inline-`ElementNode`
//     branch of that same function is gated on `!isCollapsed` and therefore
//     never fires for a caret.
//
// Together they are the evidence for the design AND for why the recorded
// alternative — marks as inline `ElementNode`s, the way `link` already is — is
// the ONE door to a genuinely real boundary position. That alternative is costed
// and deliberately NOT taken (no pending-mark channel for elements, a hard CRDT
// cutover; see the 2026-08-08 doc, "The one door to a genuinely real position").
// Test 2 is what keeps that recorded reasoning honest: if the gate ever moved,
// the alternative's central claim would be false and the record would need
// correcting.
//
// The resolver used is the exported `$createRangeSelectionFromDom` (`:7778`).
// It forwards to `$internalCreateRangeSelection(null, domSelection, editor,
// null)`, whose `eventType` is therefore `undefined` — which is exactly the
// branch that takes the DOM selection (`:7803`) rather than cloning a previous
// model selection. So this exercises the same code path a real `selectionchange`
// does, with no synthetic event and no browser.

import { afterEach, describe, expect, it } from "vitest";
import {
  $createParagraphNode,
  $createRangeSelectionFromDom,
  $createTextNode,
  $getRoot,
  createEditor,
  getDOMTextNode,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import { $createLinkNode, LinkNode } from "@lexical/link";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const roots: HTMLElement[] = [];

afterEach(() => {
  for (const el of roots.splice(0)) el.remove();
});

/**
 * A headless Lexical editor attached to a real (jsdom) element.
 *
 * The attachment is not ceremony: `$createRangeSelectionFromDom` resolves a DOM
 * node back to a Lexical key through the reconciler's own `__lexicalKey_*`
 * properties, so nothing here works until the editor has RENDERED. It also needs
 * `editor._window`, which only `setRootElement` sets.
 */
function mountEditor(): LexicalEditor {
  const root = document.createElement("div");
  document.body.appendChild(root);
  roots.push(root);
  const editor = createEditor({
    namespace: "lexical-boundary-invariant",
    // `LinkNode` is registered for BOTH cases, so the two tests differ in the
    // document they build and in nothing else.
    nodes: [LinkNode],
    onError: (error) => {
      throw error;
    },
  });
  editor.setRootElement(root);
  return editor;
}

/** The keys of a paragraph's two leaves, after a synchronous commit. */
interface Seam {
  /** The run on the LEFT of the seam — a marked `TextNode`, or a `LinkNode`. */
  leftKey: string;
  /** The plain `TextNode` on the RIGHT — `"abc"` in both fixtures. */
  rightKey: string;
}

/**
 * Build `[<left>, "abc"]` in one paragraph and commit it synchronously.
 *
 * `discrete` matters: the DOM must exist before the test reads it back, and
 * Lexical's default commit is a microtask.
 */
function seed(editor: LexicalEditor, makeLeft: () => LexicalNode): Seam {
  const keys: Partial<Seam> = {};
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      const left = makeLeft();
      const right = $createTextNode("abc");
      paragraph.append(left, right);
      $getRoot().clear().append(paragraph);
      keys.leftKey = left.getKey();
      keys.rightKey = right.getKey();
    },
    { discrete: true },
  );
  const { leftKey, rightKey } = keys;
  if (!leftKey || !rightKey) throw new Error("seed: the update never ran");
  return { leftKey, rightKey };
}

/**
 * Put the REAL DOM selection at `(node, offset)` and return it.
 *
 * A hand-rolled `{anchorNode, anchorOffset, …}` object would satisfy the four
 * fields the resolver reads, and would also pass if jsdom's `Selection` were
 * inert — so the caller asserts the placement took before resolving. A test that
 * cannot tell "the invariant holds" from "nothing happened" is worth nothing.
 */
function placeDomCaret(node: Node, offset: number): Selection {
  const selection = window.getSelection();
  if (!selection) throw new Error("jsdom exposes no window.getSelection()");
  selection.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection.addRange(range);
  return selection;
}

/** The DOM text node Lexical rendered for `key`. */
function textDomOf(editor: LexicalEditor, key: string): Text {
  const element = editor.getElementByKey(key);
  if (!element) throw new Error(`no rendered DOM for node ${key}`);
  const text = getDOMTextNode(element);
  if (!text) throw new Error(`node ${key} rendered no DOM text node`);
  return text;
}

/** The anchor `$createRangeSelectionFromDom` resolves `(node, offset)` to. */
function resolveAnchor(
  editor: LexicalEditor,
  node: Node,
  offset: number,
): { key: string; offset: number; type: "text" | "element" } {
  const domSelection = placeDomCaret(node, offset);
  // The vacuity guard described on `placeDomCaret`.
  expect(domSelection.anchorNode).toBe(node);
  expect(domSelection.anchorOffset).toBe(offset);

  return editor.getEditorState().read(
    () => {
      const selection = $createRangeSelectionFromDom(domSelection, editor);
      if (!selection) throw new Error("the DOM selection resolved to nothing");
      const { key, offset: resolved, type } = selection.anchor;
      return { key, offset: resolved, type };
    },
    { editor },
  );
}

// ---------------------------------------------------------------------------

describe("a mark boundary is ONE address (lexical@0.44.0)", () => {
  it("rewrites (plainLeaf, 0) to the END of the preceding code-formatted run", () => {
    const editor = mountEditor();
    const seam = seed(editor, () => $createTextNode("zz").setFormat("code"));

    const anchor = resolveAnchor(editor, textDomOf(editor, seam.rightKey), 0);

    // THE assertion. The caret was asked for the start of `"abc"` and was given
    // the end of `"zz"` instead — the two sides of the seam are one address, so
    // "outside the code span" is not a position the document can express.
    expect(anchor).toEqual({ key: seam.leftKey, offset: 2, type: "text" });
  });

  it("leaves (plainLeaf, 0) alone when the preceding run is an inline LinkNode", () => {
    const editor = mountEditor();
    const seam = seed(editor, () =>
      $createLinkNode("https://example.com").append($createTextNode("zz")),
    );

    const anchor = resolveAnchor(editor, textDomOf(editor, seam.rightKey), 0);

    // Same document shape, same resolver, opposite outcome — because the
    // inline-`ElementNode` branch is gated on `!isCollapsed`. With marks
    // modelled as elements, BOTH boundary states would be stable Lexical
    // addresses that round-trip the DOM, and the stored depth would be
    // unnecessary. That is the alternative's central claim, and this is it.
    expect(anchor).toEqual({ key: seam.rightKey, offset: 0, type: "text" });
  });
});
