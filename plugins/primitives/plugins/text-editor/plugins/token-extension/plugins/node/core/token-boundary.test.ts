/**
 * A token written next to something must read back as that token: the
 * boundary transform separates exactly the pairs that would fuse once
 * serialized, and nothing else.
 *
 * Run with `./equin test plugins/primitives/plugins/text-editor/plugins/token-extension`.
 */

import { describe, expect, test } from "bun:test";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  createEditor,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import { inlineBoundary } from "@plugins/ids/core";
import {
  matchTokens,
  tokenExtension,
  type InlineTokenExtension,
} from "@plugins/primitives/plugins/text-editor/plugins/token-extension/core";
import { defineInlineTokenNode } from "./inline-token-node";
import { registerTokenBoundaries } from "./token-boundary";

// An id chip, bounded the way every real id chip is (`inlineBoundary`).
const idChip = defineInlineTokenNode<{ id: string }>({
  type: "boundary-test-id",
  fields: ["id"],
  token: ({ id }) => id,
  fieldsOf: (m) => ({ id: m[0] }),
  textContent: "token",
});
const idExt = tokenExtension({
  id: "id",
  pattern: inlineBoundary(/(?<![A-Za-z0-9_-])proto-\d{10}-[a-z0-9]{4,6}/),
  node: idChip,
});

// A self-delimiting tag: nothing beside it can change where it ends.
const uiContext = defineInlineTokenNode<{ path: string }>({
  type: "boundary-test-ui-context",
  fields: ["path"],
  token: ({ path }) => `<ui-context path="${path}"/>`,
  fieldsOf: (m) => ({ path: m[1]! }),
  textContent: "token",
});
const uiExt = tokenExtension({
  id: "ui-context",
  pattern: /<ui-context path="([^"]*)"\/>/,
  node: uiContext,
});

const EXTS: readonly InlineTokenExtension[] = [idExt, uiExt];
const A = "proto-1791412353-x9vk";
const B = "proto-1791879276-g9ical";

function boundedEditor(): LexicalEditor {
  const editor = createEditor({
    namespace: "token-boundary-test",
    nodes: [idChip.Node, uiContext.Node],
    onError: (e) => {
      throw e;
    },
  });
  registerTokenBoundaries(editor, EXTS);
  return editor;
}

function update(editor: LexicalEditor, fn: () => void): void {
  editor.update(fn, { discrete: true });
}

/** The line as the serializers write it: token text, else the characters. */
function $line(): string {
  const para = $getRoot().getFirstChild();
  if (!$isElementNode(para)) return "";
  return para
    .getChildren()
    .map(
      (n: LexicalNode) =>
        EXTS.map((e) => e.serializeNode(n)).find((s) => s !== null) ??
        n.getTextContent(),
    )
    .join("");
}

function line(editor: LexicalEditor): string {
  return editor.getEditorState().read($line);
}

/** One paragraph holding `nodes`, built in one update. */
function seed(editor: LexicalEditor, build: () => LexicalNode[]): void {
  update(editor, () => {
    const para = $createParagraphNode();
    para.append(...build());
    $getRoot().clear().append(para);
  });
}

describe("token boundaries", () => {
  test("back-to-back ids get a space, and both read back", () => {
    const editor = boundedEditor();
    seed(editor, () => [idChip.create({ id: A }), idChip.create({ id: B })]);
    const text = line(editor);
    expect(text).toBe(`${A} ${B}`);
    expect(matchTokens(text, undefined, EXTS).map((m) => m.text)).toEqual([
      A,
      B,
    ]);
  });

  test("a third id pasted after two keeps every id readable", () => {
    const editor = boundedEditor();
    seed(editor, () => [idChip.create({ id: A })]);
    update(editor, () => {
      $getRoot().getFirstChild<LexicalNode>()!.selectEnd();
      const sel = $getSelection();
      if ($isRangeSelection(sel)) sel.insertNodes([idChip.create({ id: B })]);
    });
    expect(line(editor)).toBe(`${A} ${B}`);
  });

  test("a letter typed right after a chip is pushed off by a space", () => {
    const editor = boundedEditor();
    seed(editor, () => [idChip.create({ id: A }), $createTextNode("x")]);
    expect(line(editor)).toBe(`${A} x`);
  });

  test("a chip followed by a full stop or a space is left alone", () => {
    const editor = boundedEditor();
    seed(editor, () => [idChip.create({ id: A }), $createTextNode(". Done")]);
    expect(line(editor)).toBe(`${A}. Done`);
  });

  test("a self-delimiting tag stays flush against text and other tokens", () => {
    const editor = boundedEditor();
    seed(editor, () => [
      $createTextNode("see"),
      uiContext.create({ path: "a > b" }),
      uiContext.create({ path: "c" }),
      $createTextNode("here"),
    ]);
    expect(line(editor)).toBe(
      `see<ui-context path="a > b"/><ui-context path="c"/>here`,
    );
  });

  test("deleting the separating space puts it back, caret before it", () => {
    const editor = boundedEditor();
    seed(editor, () => [idChip.create({ id: A }), $createTextNode(" x")]);
    update(editor, () => {
      const text = $getRoot().getLastDescendant();
      // What a Backspace after the space leaves (the command itself needs a
      // DOM): the text without it, the caret at the joint.
      if ($isTextNode(text)) text.setTextContent("x").select(0, 0);
    });
    expect(line(editor)).toBe(`${A} x`);
    const caret = editor.getEditorState().read(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return null;
      const node = sel.anchor.getNode();
      return { text: node.getTextContent(), offset: sel.anchor.offset };
    });
    // Before the space: the next Backspace reaches the chip instead of
    // deleting a space that comes straight back.
    expect(caret).toEqual({ text: " x", offset: 0 });
  });
});
