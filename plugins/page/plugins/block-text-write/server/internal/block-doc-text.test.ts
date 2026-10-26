/**
 * `readStateRuns` — what the server can read out of a block's content doc, and
 * what it still refuses.
 *
 * The two token families here are declared LOCALLY rather than imported from the
 * plugins that ship them: `runs-corpus.ts` states the reason for the same choice
 * — importing a real decorator here would invert the plugin dependency graph
 * (active-data depends on page/editor, not the other way round). They go through
 * the SAME `defineInlineTokenNode` the real ones do, so what is exercised is the
 * shipped node synthesis, not an imitation of it.
 *
 * Run: `./equin test plugins/page/plugins/block-text-write`.
 */

import { describe, expect, test } from "bun:test";
import { encodeStateAsUpdate } from "yjs";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { tokenExtension } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/core";
import { defineInlineTokenNode } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/plugins/node/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import {
  coalesce,
  runsToXmlText,
  type RichText,
} from "@plugins/page/plugins/editor/core";
import { readStateRuns } from "./block-doc-text";

// active-data's inline chip, in shape: ONE node for every chip pattern, whose
// token IS the raw matched substring.
type ChipFields = { text: string };
const chipNode = defineInlineTokenNode<ChipFields>({
  type: "active-data-inline",
  fields: ["text"],
  token: (fields) => fields.text,
  fieldsOf: (match) => ({ text: match[0] }),
  textContent: "token",
});
const CHIP_PATTERN = /att-\d+-[a-z0-9]{4}/;
const chipExtension = tokenExtension({
  id: "chip",
  pattern: CHIP_PATTERN,
  node: chipNode,
});

// A family nothing contributes a server node for — the arm the refusal still
// covers. `textContent: "empty"` is the lossy shape: read without its extension
// it would serialize to `""`.
type OrphanFields = { id: string };
const orphanNode = defineInlineTokenNode<OrphanFields>({
  type: "orphan-token",
  fields: ["id"],
  token: ({ id }) => `<<${id}>>`,
  fieldsOf: (match) => ({ id: match[1]! }),
  textContent: "empty",
});
const ORPHAN_PATTERN = /<<([a-z0-9]+)>>/;
const orphanExtension = tokenExtension({
  id: "orphan",
  pattern: ORPHAN_PATTERN,
  node: orphanNode,
});

/** Install the server-side contributions this test's block registry should see. */
function installChipOnly(): void {
  collectContributions([
    {
      id: "test.chip",
      contributions: [
        Editor.InlineToken({
          pattern: CHIP_PATTERN,
          markdownSpan: "protect",
          agentCodeSpan: "verbatim",
          node: chipNode,
        }),
      ],
    },
  ]);
}

/** No token family contributes a node at all. */
function installNothing(): void {
  collectContributions([]);
}

/** Seed-state bytes for `runs`, with `extensions` materialized as real nodes. */
function stateFor(
  runs: RichText,
  extensions: readonly ReturnType<typeof tokenExtension>[],
): Uint8Array {
  const xmlText = runsToXmlText(runs, {
    extensions,
    nodes: extensions.map((e) => e.node.Node),
  });
  return encodeStateAsUpdate(xmlText.doc!);
}

describe("readStateRuns", () => {
  const chipRuns: RichText = [{ text: "see att-1755000000-ab12 for details" }];

  test("a doc holding an active-data-inline node reads back its token", () => {
    const state = stateFor(chipRuns, [chipExtension]);
    installChipOnly();
    expect(readStateRuns(state, "block-chip")).toEqual(coalesce(chipRuns));
  });

  test("the same doc is REFUSED when nothing contributes that node, naming the type", () => {
    // The pair is what proves the doc really holds a materialized decorator
    // rather than plain characters: with no server node there is a
    // `Y.XmlElement` to refuse, and the refusal names it.
    const state = stateFor(chipRuns, [chipExtension]);
    installNothing();
    expect(() => readStateRuns(state, "block-chip")).toThrow(
      /active-data-inline/,
    );
  });

  test("marks either side of a chip survive the read", () => {
    const runs: RichText = [
      { text: "bold ", marks: ["bold"] },
      { text: "att-1755000000-ab12" },
      { text: " tail", color: "blue" },
    ];
    const state = stateFor(runs, [chipExtension]);
    installChipOnly();
    expect(readStateRuns(state, "block-marks")).toEqual(coalesce(runs));
  });

  test("an UNREGISTERED decorator type still throws, naming only it", () => {
    const runs: RichText = [{ text: "chip att-1755000000-ab12 orphan <<zz>>" }];
    const state = stateFor(runs, [chipExtension, orphanExtension]);
    installChipOnly();
    let message = "";
    try {
      readStateRuns(state, "block-mixed");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("orphan-token");
    // The registered family was SUBTRACTED — the refusal narrowed rather than
    // firing on every decorator in the doc.
    expect(message).not.toContain("active-data-inline");
    expect(message).toContain("block-mixed");
  });
});
