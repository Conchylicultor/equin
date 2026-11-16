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
  RootNode,
  TextNode,
  type LexicalEditor,
  $isParagraphNode,
  type ParagraphNode,
} from "lexical";
import { defineInlineTokenNode } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/plugins/node/core";
import { $liftOffOpenLine, $repairOrphans, GO_MARKER_TYPE } from "./go-regions";

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
  editor.registerNodeTransform(RootNode, $repairOrphans);
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

function $firstPara(): ParagraphNode {
  const para = $getRoot().getFirstChild();
  if (!$isParagraphNode(para)) throw new Error("no paragraph");
  return para;
}

describe("a marker left without its partner", () => {
  /** `<go>do it</go> and more`, committed. */
  function inlineDraft(): LexicalEditor {
    return editorWith(() => {
      $getRoot().append(
        $createParagraphNode().append(
          marker.create({ edge: "open" }),
          $createTextNode("do it"),
          marker.create({ edge: "close" }),
          $createTextNode(" and more"),
        ),
      );
    });
  }

  /** Commits made by `edit` — each one is a history entry (one ⌘Z). */
  function commitsOf(editor: LexicalEditor, edit: () => void): number {
    let commits = 0;
    const off = editor.registerUpdateListener(
      ({ dirtyElements, dirtyLeaves }) => {
        if (dirtyElements.size > 0 || dirtyLeaves.size > 0) commits++;
      },
    );
    editor.update(edit, { discrete: true });
    off();
    return commits;
  }

  test("goes with it when the edit took everything but the marker, in the same commit", () => {
    const editor = inlineDraft();
    // A drag selection from the end reaches every node but the zero-width open
    // marker; deleting it leaves the marker alone.
    const commits = commitsOf(editor, () => {
      const [, ...rest] = $firstPara().getChildren();
      for (const node of rest) node.remove();
    });
    expect(text(editor)).toBe("");
    expect(commits).toBe(1);
  });

  test("goes with it when its ✕ edge is deleted, the words staying", () => {
    const editor = inlineDraft();
    editor.update(
      () => {
        const para = $firstPara();
        para.getChildAtIndex(2)!.remove();
      },
      { discrete: true },
    );
    expect(text(editor)).toBe("do it and more");
  });

  test("stays literal text when it arrives unpaired", () => {
    const editor = editorWith(() => {
      $getRoot().append($createParagraphNode().append($createTextNode("a")));
    });
    editor.update(
      () => {
        $firstPara().append(marker.create({ edge: "open" }));
      },
      { discrete: true },
    );
    expect(text(editor)).toBe("a<go>");
    const types = editor.getEditorState().read(() =>
      $firstPara()
        .getChildren()
        .map((n) => n.getType()),
    );
    expect(types).not.toContain(GO_MARKER_TYPE);
  });
});
