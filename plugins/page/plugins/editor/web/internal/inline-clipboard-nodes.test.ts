/**
 * Headless Lexical tests for the clipboard-node flattener that keeps a block to
 * ONE paragraph. Run with
 * `./equin test plugins/page/plugins/editor/web/internal/inline-clipboard-nodes.test.ts`.
 */
import { test, expect, describe } from "bun:test";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isLineBreakNode,
  $isTextNode,
  createEditor,
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
} from "lexical";
import { $isLinkNode, LinkNode, $createLinkNode } from "@lexical/link";
import { $flattenToInline, isBlockLevel } from "./inline-clipboard-nodes";

/** A block-level decorator: owns no children, so it has no inline form. */
class BlockCardNode extends DecoratorNode<null> {
  static getType(): string {
    return "test-block-card";
  }
  static clone(node: BlockCardNode): BlockCardNode {
    return new BlockCardNode(node.__key);
  }
  static importJSON(): BlockCardNode {
    return new BlockCardNode();
  }
  constructor(key?: NodeKey) {
    super(key);
  }
  exportJSON(): SerializedLexicalNode {
    return { type: "test-block-card", version: 1 };
  }
  isInline(): false {
    return false;
  }
  createDOM(): HTMLElement {
    throw new Error("headless");
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

/**
 * Run `build` inside an update and report the flattened result, shape-first:
 * the inline arm as its node shapes, the other two arms as their kind.
 */
function flatten(
  build: () => LexicalNode[],
): string[] | "empty" | "not-inline" {
  const editor = createEditor({
    namespace: "test",
    nodes: [LinkNode, BlockCardNode],
    onError: (e) => {
      throw e;
    },
  });
  let out: string[] | "empty" | "not-inline" = "empty";
  editor.update(
    () => {
      // A root is needed for node creation; the payload itself stays detached,
      // exactly as clipboard-generated nodes arrive.
      $getRoot().append($createParagraphNode());
      const flat = $flattenToInline(build());
      out =
        flat.kind !== "inline"
          ? flat.kind
          : flat.nodes.map((n) =>
              $isLineBreakNode(n)
                ? "⏎"
                : $isLinkNode(n)
                  ? `link(${n.getTextContent()})`
                  : $isTextNode(n)
                    ? n.getTextContent()
                    : n.getType(),
            );
    },
    { discrete: true },
  );
  return out;
}

const para = (...texts: string[]) => {
  const p = $createParagraphNode();
  for (const t of texts) p.append($createTextNode(t));
  return p;
};

describe("$flattenToInline", () => {
  test("one paragraph loses its box and keeps its content", () => {
    expect(flatten(() => [para("hello")])).toEqual(["hello"]);
  });

  test("consecutive paragraphs join with a soft break, never a second block", () => {
    expect(flatten(() => [para("a"), para("b"), para("c")])).toEqual([
      "a",
      "⏎",
      "b",
      "⏎",
      "c",
    ]);
  });

  test("a block followed by loose inline content still breaks between them", () => {
    // The boundary rule is about content on BOTH sides, not about a leading
    // edge: `<p>a</p>tail` must not fuse into "atail".
    expect(flatten(() => [para("a"), $createTextNode("tail")])).toEqual([
      "a",
      "⏎",
      "tail",
    ]);
  });

  test("loose inline content followed by a block breaks between them too", () => {
    expect(flatten(() => [$createTextNode("head"), para("a")])).toEqual([
      "head",
      "⏎",
      "a",
    ]);
  });

  test("an all-inline payload passes through untouched", () => {
    expect(
      flatten(() => [$createTextNode("a"), $createLineBreakNode()]),
    ).toEqual(["a", "⏎"]);
  });

  test("an inline element keeps its own children (marks and links survive)", () => {
    expect(
      flatten(() => {
        const link = $createLinkNode("https://example.com");
        link.append($createTextNode("here"));
        const p = $createParagraphNode();
        p.append($createTextNode("go "), link);
        return [p];
      }),
    ).toEqual(["go ", "link(here)"]);
  });

  test("an empty leading block contributes no leading break", () => {
    expect(flatten(() => [para(), para("b")])).toEqual(["b"]);
  });

  test("an empty TRAILING block contributes no trailing break", () => {
    // `<p>a</p><p></p>` is ordinary tail output from real editors; a stray
    // trailing break would park the caret on it and persist a trailing newline.
    expect(flatten(() => [para("a"), para()])).toEqual(["a"]);
  });

  test("block structure carrying no content is `empty`, not a refusal", () => {
    // Distinct arms because they need distinct decisions: `empty` still has to
    // REPLACE the selection, `not-inline` must hand the insert back to Lexical.
    expect(flatten(() => [para(), para()])).toBe("empty");
  });

  test("a non-inline decorator has no inline form, so the payload is refused", () => {
    // Refused, NOT silently dropped: the caller then leaves Lexical's own insert
    // to run, so the user's content still arrives.
    expect(flatten(() => [para("a"), new BlockCardNode()])).toBe("not-inline");
  });
});

describe("isBlockLevel", () => {
  test("mirrors Lexical's own block/inline split", () => {
    const editor = createEditor({
      namespace: "test",
      nodes: [LinkNode, BlockCardNode],
      onError: (e) => {
        throw e;
      },
    });
    let seen: boolean[] = [];
    editor.update(
      () => {
        const link = $createLinkNode("https://example.com");
        seen = [
          isBlockLevel(para("x")),
          isBlockLevel(new BlockCardNode()),
          isBlockLevel(link),
          isBlockLevel($createTextNode("x")),
          isBlockLevel($createLineBreakNode()),
        ];
      },
      { discrete: true },
    );
    expect(seen).toEqual([true, true, false, false, false]);
  });
});
