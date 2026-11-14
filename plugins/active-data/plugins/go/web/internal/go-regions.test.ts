/**
 * A block region's open marker draws nothing, so its line looks empty and
 * outside the box: text typed there must land above the region, not in it.
 */
import { describe, expect, test } from "bun:test";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  createEditor,
  TextNode,
  type LexicalEditor,
} from "lexical";
import { defineInlineTokenNode } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/plugins/node/core";
import { $liftOffOpenLine, GO_MARKER_TYPE } from "./go-regions";

const marker = defineInlineTokenNode<{ edge: "open" | "close" }>({
  type: GO_MARKER_TYPE,
  fields: ["edge"],
  token: ({ edge }) => (edge === "open" ? "<go>" : "</go>"),
  fieldsOf: (m) => ({ edge: m[0] === "<go>" ? "open" : "close" }),
  textContent: "token",
});

function editorWith(build: () => void): LexicalEditor {
  const editor = createEditor({
    namespace: "go-regions-test",
    nodes: [marker.Node],
    onError: (e) => {
      throw e;
    },
  });
  editor.registerNodeTransform(TextNode, $liftOffOpenLine);
  editor.update(build, { discrete: true });
  return editor;
}

const text = (editor: LexicalEditor) =>
  editor.getEditorState().read(() => $getRoot().getTextContent());

/** `<go>⏎item</go>`, the caret right after the open marker. */
function blockDraft(): LexicalEditor {
  return editorWith(() => {
    const open = marker.create({ edge: "open" });
    const para = $createParagraphNode().append(
      open,
      $createLineBreakNode(),
      $createTextNode("item"),
      marker.create({ edge: "close" }),
    );
    $getRoot().append(para);
    para.select(1, 1);
  });
}

describe("typing on a block region's open-marker line", () => {
  test("goes before the marker, and keeps going there", () => {
    const editor = blockDraft();
    for (const ch of ["e", "d"]) {
      editor.update(
        () => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel)) throw new Error("no caret");
          sel.insertText(ch);
        },
        { discrete: true },
      );
    }
    expect(text(editor)).toBe("ed<go>\nitem</go>");
  });

  test("an inline region keeps what is typed inside it", () => {
    const editor = editorWith(() => {
      const para = $createParagraphNode().append(
        marker.create({ edge: "open" }),
        $createTextNode("do it"),
        marker.create({ edge: "close" }),
      );
      $getRoot().append(para);
    });
    expect(text(editor)).toBe("<go>do it</go>");
  });

  test("text on the item lines stays inside", () => {
    const editor = blockDraft();
    editor.update(
      () => {
        const item = $getRoot().getAllTextNodes()[0]!;
        item.setTextContent("item!");
      },
      { discrete: true },
    );
    expect(text(editor)).toBe("<go>\nitem!</go>");
  });
});
