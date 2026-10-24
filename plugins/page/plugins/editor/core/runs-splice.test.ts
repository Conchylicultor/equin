/**
 * `$spliceRunsInto` with a token extension set: the alignment must treat a
 * materialized decorator as an ordinary unit keyed on its TOKEN, so an
 * unchanged chip keeps its node (and with it its CRDT item) while a changed
 * middle re-materializes one.
 *
 * Headless Lexical under Bun — the corpus's decorator never renders.
 * Run: `./equin test plugins/page/plugins/editor/core`.
 */

import { describe, expect, test } from "bun:test";
import {
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  createEditor,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import { LinkNode } from "@lexical/link";
import { coalesce, type RichText } from "./rich-text";
import { runsToLexical, serializeBlockRuns } from "./runs-lexical";
import { $spliceRunsInto } from "./runs-splice";
import {
  corpusTokenExtension,
  prng,
  randomRuns,
  TokenNode,
} from "./runs-corpus";

// The fuzz corpus is the shared one (`./runs-corpus.ts`): the synthetic token
// family, declared through the same shipped primitives the real ones use, and
// the seeded generator. `[[tok-gen]]` in its piece set is what materializes as a
// node under {@link extensions}.
const extensions = [corpusTokenExtension];

function makeEditor(runs: RichText): LexicalEditor {
  const editor = createEditor({
    namespace: "runs-splice-test",
    nodes: [LinkNode, TokenNode],
    onError: (e) => {
      throw e;
    },
  });
  editor.update(() => runsToLexical(runs, extensions), { discrete: true });
  return editor;
}

function splice(editor: LexicalEditor, runs: RichText): void {
  editor.update(() => $spliceRunsInto(runs, extensions), { discrete: true });
}

/** Every decorator leaf in the document, as `[nodeKey, tokenText]` pairs. */
function decorators(editor: LexicalEditor): [string, string][] {
  const out: [string, string][] = [];
  editor.getEditorState().read(() => {
    const walk = (node: LexicalNode): void => {
      if ($isElementNode(node)) {
        for (const child of node.getChildren()) walk(child);
        return;
      }
      if ($isTextNode(node) || $isLineBreakNode(node)) return;
      out.push([node.getKey(), corpusTokenExtension.serializeNode(node) ?? ""]);
    };
    for (const child of $getRoot().getChildren()) walk(child);
  });
  return out;
}

describe("$spliceRunsInto with token extensions", () => {
  test("changing the text AROUND a token preserves the decorator's node key", () => {
    const editor = makeEditor([{ text: "alpha [[tok-x]] omega" }]);
    const before = decorators(editor);
    expect(before).toEqual([[before[0]![0], "[[tok-x]]"]]);

    const next: RichText = [{ text: "alphaX [[tok-x]] omega" }];
    splice(editor, next);

    // The SAME node object survived the splice — which is what keeps its CRDT
    // item, and therefore the chip, alive through an agent edit.
    expect(decorators(editor)).toEqual(before);
    expect(serializeBlockRuns(editor, extensions)).toEqual(coalesce(next));
  });

  test("a token in the CHANGED middle re-materializes as a node", () => {
    const editor = makeEditor([{ text: "alpha [[tok-x]] omega" }]);
    const beforeKey = decorators(editor)[0]![0];

    const next: RichText = [{ text: "alpha [[tok-y]] omega" }];
    splice(editor, next);

    const after = decorators(editor);
    expect(after.map(([, token]) => token)).toEqual(["[[tok-y]]"]);
    // A different token is a different unit, so the middle was rebuilt — the
    // rebuild must produce a NODE, not the characters that spell it.
    expect(after[0]![0]).not.toBe(beforeKey);
    expect(serializeBlockRuns(editor, extensions)).toEqual(coalesce(next));
  });

  test("a token appearing where there was none becomes a node", () => {
    const editor = makeEditor([{ text: "plain text" }]);
    expect(decorators(editor)).toEqual([]);

    const next: RichText = [{ text: "plain [[tok-z]] text" }];
    splice(editor, next);

    expect(decorators(editor).map(([, token]) => token)).toEqual(["[[tok-z]]"]);
    expect(serializeBlockRuns(editor, extensions)).toEqual(coalesce(next));
  });

  test("removing a token's characters removes the node", () => {
    const editor = makeEditor([{ text: "alpha [[tok-x]] omega" }]);
    splice(editor, [{ text: "alpha omega" }]);
    expect(decorators(editor)).toEqual([]);
    expect(serializeBlockRuns(editor, extensions)).toEqual(
      coalesce([{ text: "alpha omega" }]),
    );
  });

  test("a code-marked run keeps its token as characters, on both sides", () => {
    // `matchTokens` yields nothing for a `code` run, so `lineNodes` builds no
    // node — and the splice's own unit walk must agree, or it would align a
    // token unit against a text one.
    const runs: RichText = [{ text: "[[tok-x]]", marks: ["code"] }];
    const editor = makeEditor(runs);
    expect(decorators(editor)).toEqual([]);

    const next: RichText = [{ text: "[[tok-x]] tail", marks: ["code"] }];
    splice(editor, next);
    expect(decorators(editor)).toEqual([]);
    expect(serializeBlockRuns(editor, extensions)).toEqual(coalesce(next));
  });

  test("emptying a paragraph clears the pending format its text left on it", () => {
    // What a live editor's reconciler stamps on a paragraph holding bold text,
    // and what the binding syncs into the doc — so the splice inherits it.
    const editor = makeEditor([{ text: "bold", marks: ["bold"] }]);
    editor.update(
      () => {
        const p = $getRoot().getFirstChild();
        if (!$isElementNode(p)) throw new Error("expected a paragraph");
        p.setTextFormat(1);
        p.setTextStyle("color: red");
      },
      { discrete: true },
    );

    splice(editor, []);

    editor.getEditorState().read(() => {
      const p = $getRoot().getFirstChild();
      if (!$isElementNode(p)) throw new Error("expected a paragraph");
      expect(p.getTextFormat()).toBe(0);
      expect(p.getTextStyle()).toBe("");
    });
  });

  test("fuzz: a splice lands exactly what a fresh seed of the same runs would", () => {
    // The reference is a REBUILD, not `coalesce(to)`: the runs↔Lexical mapping
    // emits a `LineBreakNode` as an unmarked run, so a marked run carrying a
    // soft `\n` legitimately comes back as three runs however it was built.
    // What the splice owes is that its incremental path and the wholesale one
    // agree — that is the property, and it is the one an agent edit depends on.
    const rand = prng(0x5eed);
    for (let i = 0; i < 400; i++) {
      const from = randomRuns(rand);
      const to = randomRuns(rand);

      const editor = makeEditor(from);
      splice(editor, to);

      expect(serializeBlockRuns(editor, extensions)).toEqual(
        serializeBlockRuns(makeEditor(to), extensions),
      );
      // And every token in `to` is a NODE, never the characters that spell it.
      expect(decorators(editor).map(([, token]) => token)).toEqual(
        decorators(makeEditor(to)).map(([, token]) => token),
      );
    }
  });
});
