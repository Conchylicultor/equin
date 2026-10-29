import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  conversionPrefixesOf,
  defineBlock,
  type BlockHandle,
} from "./define-block";
import { textDataSchema } from "./text-data";
import { plainOf, type RichText } from "./rich-text";
import type { SerializedBlock } from "./serialized-block";
import { withMintedIds } from "./serialized-block";
import {
  parseMarkdownToForest,
  serializeForestToMarkdown,
  defaultTextHandle,
  markdownLineClaim,
  markdownParseTagNames,
  markdownTagIsIdentified,
  markdownTagNameOf,
  markdownTagNamesAuthoredBy,
  type BlockTagSpelling,
  type MarkdownContext,
  type MarkdownNode,
  dropBlankLinesBesideTags,
  unwrapAgentCodeSpans,
} from "./markdown";
import { loadBlockHandles } from "./testing";

// The orchestrator is parameterized on `BlockHandle[]`, and this suite hands it
// the REAL ONES: every block type the app ships, read off the plugin tree by
// `loadBlockHandles()`, which imports each contributing plugin's web barrel and
// throws rather than handing back an empty set.
//
// The loader is test code (`./testing`), host-only (it walks the plugin tree
// and imports web barrels at runtime), so it reaches the block plugins without
// a static import of them. A static import of the block plugins' own cores
// would be a cycle: each of them imports `defineBlock` from this plugin's core.
//
// WHAT THIS REPLACED, because it is the reason for the cost below: a
// hand-written copy of 26 handles, which was wrong about exactly the tags
// `edit_page` depends on. It spelled the agent's card `<agent-notes>` where the
// real one is `<agent-inline id="…">`, gave `<todo>` and `<human>` no row id at
// all, knew two of the callout's five colours, and did not have `instructions`
// or `place` in it. So the round-trip property — the executable statement that
// markdown is a lossless projection of the forest — was a statement about a
// document nobody ever writes. A slow honest test is worth more than a fast one
// about a fiction.
//
// The load is a TOP-LEVEL `await`, deliberately not a `beforeAll`: it takes
// ~11 s (it builds the enriched plugin tree, then evaluates 28 web barrels,
// `lexical` among them), and Bun's default per-test timeout is
// 5 s, which nothing in this repo overrides. At module scope no test timer
// covers it; inside a hook one would, and every run would fail on the clock.
const handles = await loadBlockHandles();

/**
 * The real handle for one block type, or a THROW naming what IS registered.
 *
 * Every per-type assertion below looks its subject up through this instead of
 * holding a module variable, so a type that is renamed or removed fails HERE —
 * once, saying so — rather than making whichever expectation happened to
 * mention it read as a markdown bug.
 */
function byType(type: string): BlockHandle<unknown> {
  const found = handles.find((h) => h.type === type);
  if (!found) {
    throw new Error(
      `No block handle of type "${type}" is registered. Registered types: ` +
        handles.map((h) => h.type).join(", "),
    );
  }
  return found;
}

// No token extensions in the pure suite: `protectedSpans` is exercised directly
// in `inline-markdown.test.ts`, where the masking rule lives.
//
// The default dialect here is OUR OWN (`"empty-block"`), because that is the
// document the round-trip property is about — what this codebase emits is what
// it must read back. `pasteCtx` is the other half of the asymmetry, for the
// tests that assert a pasted foreign document is unchanged by it.
const mdCtx: MarkdownContext = {
  handles,
  protectedSpans: [],
  blankLines: "empty-block",
  // Our own dialect on the way out too: an empty paragraph a blank line cannot
  // place is PINNED as `<text/>`, which is what makes the round-trip property
  // below exact rather than exact-modulo-a-filter.
  emptyBlocks: "pinned",
  // And a soft break is the two characters `\n`, so a block that holds one
  // still occupies exactly ONE document line — the other half of what makes the
  // round-trip property below exact.
  softBreaks: "escaped",
};
const pasteCtx: MarkdownContext = {
  ...mdCtx,
  blankLines: "separator",
  emptyBlocks: "blank-line",
  softBreaks: "newline",
};
const parse = (md: string): SerializedBlock[] =>
  parseMarkdownToForest(md, mdCtx);
const parsePasted = (md: string): SerializedBlock[] =>
  parseMarkdownToForest(md, pasteCtx);
const serialize = (forest: SerializedBlock[]): string =>
  serializeForestToMarkdown(forest, mdCtx);

/** A leaf serialized block (no children). */
const node = (type: string, data: unknown): SerializedBlock => ({
  type,
  data,
  expanded: true,
  children: [],
});
const runs = (s: string): RichText => (s ? [{ text: s }] : []);
/** The parsed `text` field flattened to a plain string (parse emits runs). */
const dataText = (b: SerializedBlock): string =>
  plainOf((b.data as { text?: unknown }).text);

describe("defaultTextHandle", () => {
  test("selects the block declaring `defaultText`", () => {
    expect(defaultTextHandle(handles)).toBe(byType("text"));
  });
});

describe("plain paragraphs", () => {
  test("parse → default text type with runs", () => {
    const forest = parse("hello world");
    expect(forest).toHaveLength(1);
    expect(forest[0]!.type).toBe("text");
    expect(dataText(forest[0]!)).toBe("hello world");
  });

  test("serialize a text block emits the bare line", () => {
    expect(serialize([node("text", { text: runs("hello") })])).toBe("hello");
  });

  test("a blank line is an empty paragraph — one block per line, no counting", () => {
    const forest = parse("a\n\n\nb");
    expect(forest.map((b) => b.type)).toEqual(["text", "text", "text", "text"]);
    expect(forest.map(dataText)).toEqual(["a", "", "", "b"]);
  });

  test("under the paste dialect blank lines are still skipped", () => {
    // The lenient half of the contract, unchanged: in foreign markdown a blank
    // line separates paragraphs, so reading it as an empty paragraph would put
    // one between every two paragraphs of a pasted README.
    const forest = parsePasted("a\n\n\nb");
    expect(forest.map((b) => b.type)).toEqual(["text", "text"]);
    expect(forest.map(dataText)).toEqual(["a", "b"]);
  });
});

describe("soft line breaks (a block's text is ONE document line)", () => {
  // A `\n` inside a run is first-class content — Shift+Enter, or a paste of
  // multi-paragraph HTML with a single-line `text/plain` beside it. Markdown was
  // the one layer with no spelling for it: the newline went out verbatim, the
  // walk fanned that one block into several document lines at its own indent,
  // and the parser read them back as exactly that. The escape keeps the block on
  // one line, so nothing about the document's line, indent or blank-line rules
  // has to know a break happened.
  //
  // `"\\n"` in these expectations is the TWO characters backslash + `n`.

  test("an interior break keeps the block on one line, both ways", () => {
    const forest = [node("text", { text: runs("Goal: x\nRisk: y") })];
    expect(serialize(forest)).toBe("Goal: x\\nRisk: y");
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("a TRAILING break round-trips too — the `<p>a</p><p></p>` paste shape", () => {
    const forest = [node("text", { text: runs("a\n") })];
    expect(serialize(forest)).toBe("a\\n");
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("a block whose text is ONLY a break survives, where it used to be deleted", () => {
    // The empty-block pin tests `line.trim() === ""`, which a lone newline
    // satisfied — so the block was emitted as `<text/>` and came back with
    // `text: []`. The escape makes the line two non-blank characters, so the pin
    // correctly declines and the block keeps its content.
    const forest = [node("text", { text: runs("\n") })];
    expect(serialize(forest)).toBe("\\n");
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("a marked run's interior break round-trips, delimiters and all", () => {
    // `matchDelimiter` abandons a span at a REAL newline, which is why the
    // escape exists: with no newline in the line, the closing `**` is found.
    const forest = [
      node("text", { text: [{ text: "a\nb", marks: ["bold" as const] }] }),
    ];
    expect(serialize(forest)).toBe("**a\\nb**");
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("a prefixed line keeps its prefix — the break never mints a sibling", () => {
    expect(
      serialize([node("to-do", { text: runs("a\nb"), checked: true })]),
    ).toBe("- [x] a\\nb");
    expect(serialize([node("numbered-list", { text: runs("a\nb") })])).toBe(
      "1. a\\nb",
    );
    expect(parse("- [x] a\\nb")).toEqual([
      node("to-do", { text: runs("a\nb"), checked: true }),
    ]);
  });

  test("a code block STILL emits three lines — the encode site's regression guard", () => {
    // `code-block` declares an explicit `markdown.serialize` returning a
    // genuinely multi-line fenced string, and `renderList`'s `line.split("\n")`
    // is what turns it into real lines. Escaping there instead of in run text
    // would collapse every fence onto one line and turn the code's own newlines
    // into literal `\n`.
    const forest = [node("code-block", { code: "a\nb", language: "ts" })];
    expect(serialize(forest)).toBe("```ts\na\nb\n```");
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("the `newline` dialect emits the real break, and states the loss", () => {
    // What the clipboard declares: a person pasting into another app must see a
    // line break, not two characters. The cost is that this document cannot be
    // read back as one block — which is exactly the bug the escape closes, kept
    // knowingly on the human-facing side.
    const humanCtx: MarkdownContext = { ...mdCtx, softBreaks: "newline" };
    const md = serializeForestToMarkdown(
      [node("text", { text: runs("a\nb") })],
      humanCtx,
    );
    expect(md).toBe("a\nb");
    expect(parse(md)).toHaveLength(2);
  });
});

describe("line claims (a paragraph that opens like a list)", () => {
  // A stored paragraph reading `3. Investigate…` went out as a BARE line and
  // came back a `numbered-list` — a different row, so reading a page out and
  // applying it back unchanged planned a delete and a create, and `edit_page`
  // refused every edit to that page. Ten paragraphs across three pages on main
  // were un-editable this way. The serializer now asks what the parser would do
  // with the line it is about to write, and spells the paragraph with one
  // leading backslash when another type would take it.

  /** Each line, and the type that claims it when nothing is escaped. */
  const claimed = [
    ["3. x", "numbered-list"],
    ["10) x", "numbered-list"],
    ["- x", "bulleted-list"],
    ["+ x", "bulleted-list"],
    ["# x", "heading-1"],
    ["## x", "heading-2"],
    ["> x", "toggle"],
    ["$$x", "equation"],
    ["---", "divider"],
    // `divider` compares `trim()`, so this one is claimed THROUGH its leading
    // whitespace — and the whitespace is the paragraph's own content.
    ["  ---", "divider"],
    // …and this one is claimed only once the indent is off, which is what the
    // probe has to strip: `^\d+` does not match `"  3. x"`. Probing the raw
    // line answers *prose*, nothing is escaped, and the block is lost on the
    // way back exactly as before.
    ["  3. x", "numbered-list"],
  ] as const;

  test("the bare line IS claimed — the loss this closes", () => {
    for (const [line, claimant] of claimed) {
      expect([line, parse(line)[0]!.type]).toEqual([line, claimant]);
    }
  });

  test("a paragraph is escaped once, round-trips exactly, and is idempotent", () => {
    for (const [line] of claimed) {
      const forest = [node("text", { text: runs(line) })];
      const md = serialize(forest);
      // ONE line, one backslash, at index 0 of the WHOLE line — ahead of any
      // leading whitespace the text carries, which is how `"  ---"` keeps its
      // two spaces.
      expect(md).toBe("\\" + line);
      expect(md.split("\n")).toHaveLength(1);
      expect(parse(md)).toEqual(forest);
      expect(serialize(parse(md))).toBe(md);
    }
  });

  test("a whitespace-only paragraph is escaped too — a blank line would empty it", () => {
    // Nobody claims `" "`; the BLANK-LINE rule does, reading it back as an empty
    // paragraph. On a page, that loss made every `edit_page` refuse: the diff
    // saw the author's paragraph rewritten from " " to "".
    for (const text of [" ", "   "]) {
      const forest = [
        node("heading-2", { text: runs("A") }),
        node("text", { text: runs(text) }),
        node("text", { text: runs("B") }),
      ];
      const md = serialize(forest);
      expect(md).toBe(`## A\n\\${text}\nB`);
      expect(parse(md)).toEqual(forest);
      expect(serialize(parse(md))).toBe(md);
    }
    // A lone backslash is still just a backslash.
    expect(parse("\\")).toEqual([node("text", { text: runs("\\") })]);
  });

  test("the decode is unconditional across dialects, like every other decode", () => {
    // Lenient on parse, canonical on serialize. `\- x` means a literal `- x`
    // paragraph in CommonMark too, so a pasted document reads MORE faithfully.
    expect(parsePasted("\\3. x")).toEqual([
      node("text", { text: runs("3. x") }),
    ]);
  });

  test("the already-safe set gains NO escape — the check reads the EMITTED line", () => {
    // `*`, `[`, `]`, `` ` `` and `<` are inline escape spellings, so by the time
    // the line exists no claimer can reach its first character. That the check
    // agrees is the proof it probes the emitted line rather than the run text.
    for (const [stored, emitted] of [
      ["* x", "\\* x"],
      ["[ ] x", "\\[ \\] x"],
      ["```x", "\\`\\`\\`x"],
      ['<page id="p1"/>', '\\<page id="p1"/>'],
    ] as const) {
      const forest = [node("text", { text: runs(stored) })];
      expect(serialize(forest)).toBe(emitted);
      expect(parse(emitted)).toEqual(forest);
    }
  });

  test("a literal backslash is a fixed point, escaped line or not", () => {
    // `\- foo` decodes (a claimer takes `- foo`); `\\- foo` does not (nothing
    // claims `\- foo`), and its backslash is the INLINE table's. Both have to
    // survive re-emission unchanged, or a document drifts one backslash per
    // round trip.
    for (const md of ["\\- foo", "\\3. x", "\\\\- foo"]) {
      expect(serialize(parse(md))).toBe(md);
      expect(serialize(parse(serialize(parse(md))))).toBe(md);
    }
  });

  test("a lone soft break still reads as a break, not as the letter `n`", () => {
    // Why the decode gates on a real CLAIM and not on the backslash alone: a
    // block whose text is one soft break emits the line `\n`, which begins with
    // a backslash and is prose. An unconditional strip rewrites it to `n`.
    const forest = [node("text", { text: runs("\n") })];
    expect(serialize(forest)).toBe("\\n");
    expect(parse("\\n")).toEqual(forest);
  });

  test("a claiming type's own line is never escaped, and keeps its type", () => {
    for (const [type, data, line] of [
      ["numbered-list", { text: runs("2. x") }, "1. 2. x"],
      ["heading-1", { text: runs("# x") }, "# # x"],
      // The brackets in the TEXT carry the INLINE escape, which is the other
      // layer and untouched by any of this: what the line-claim check reads is
      // the to-do's own `- [ ] ` prefix, which the to-do itself parses back.
      ["to-do", { text: runs("- [ ] y"), checked: false }, "- [ ] - \\[ \\] y"],
      // `* `, not `- `: a type emits its CANONICAL prefix (`markdownPrefixes[0]`),
      // and this one declares `["* ", "- ", "+ "]`. So the bullet marker and the
      // text's own leading `- ` are visibly different characters here.
      ["bulleted-list", { text: runs("- z") }, "* - z"],
    ] as const) {
      const forest = [node(type, data)];
      expect(serialize(forest)).toBe(line);
      expect(parse(line)).toEqual(forest);
    }
  });

  test("a code block still emits three lines and is not escaped", () => {
    // The fence is the ONE exemption from the one-line assert, and it is
    // self-delimiting: its body is not offered to the claimers at all, so a line
    // of code reading `3. x` needs nothing.
    const forest = [node("code-block", { code: "3. x", language: "ts" })];
    expect(serialize(forest)).toBe("```ts\n3. x\n```");
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("a multi-line equation throws in our dialect, and not in the clipboard's", () => {
    // `equation` serializes `"$$" + expression` straight out of a textarea, so a
    // multi-line expression fanned its lines 2..n out as sibling paragraphs —
    // the soft break's bug on another type. The clipboard dialect is
    // deliberately lossy and must never throw during a Cmd+C.
    const forest = [node("equation", { expression: "a\nb" })];
    expect(() => serialize(forest)).toThrow(/equation/);
    expect(() =>
      serializeForestToMarkdown(forest, { ...mdCtx, softBreaks: "newline" }),
    ).not.toThrow();
  });

  test("a type whose own line it cannot parse back throws, rather than escaping", () => {
    // Escaping a NON-default owner would silently convert the block to a
    // paragraph on the way back (`\- [ ] x` is not a to-do), which is the very
    // damage this closes — so the disagreement has to be fixed where it is
    // declared. Unreachable with today's handles.
    const broken = defineBlock({
      type: "broken",
      schema: textDataSchema,
      empty: () => ({ text: [] }),
      markdown: {
        serialize: (d, ctx) => "- " + ctx.md(d.text),
        // No samples, because the whole point of the fixture is a claimer that
        // claims NOTHING while emitting a line `bulleted-list` claims.
        parseLine: { claims: [], parse: () => null },
      },
    });
    const ctx: MarkdownContext = {
      ...mdCtx,
      handles: [...handles, broken as BlockHandle<unknown>],
    };
    expect(() =>
      serializeForestToMarkdown([node("broken", { text: runs("x") })], ctx),
    ).toThrow(/"broken".*"bulleted-list"/s);
    // One rule for every assert here: our own dialect asserts, the clipboard
    // never throws — a Cmd+C may not crash, whatever the document holds.
    expect(() =>
      serializeForestToMarkdown([node("broken", { text: runs("x") })], {
        ...ctx,
        softBreaks: "newline",
      }),
    ).not.toThrow();
  });

  test("a hand-written line opening with `<` throws — the tag branch is not modelled", () => {
    // `claimTag` is multi-line and can decline after consuming nothing, so it is
    // not a single-line predicate and the claim authority skips it. This assert
    // is what makes that omission honest.
    const tagish = defineBlock({
      type: "tagish",
      schema: textDataSchema,
      empty: () => ({ text: [] }),
      markdown: {
        serialize: (d, ctx) => "<tagish>" + ctx.md(d.text),
        parseLine: {
          claims: ["<tagish>x"],
          parse: (line, ctx) =>
            line.startsWith("<tagish>")
              ? { text: ctx.runs(line.slice(8)) }
              : null,
        },
      },
    });
    const ctx: MarkdownContext = {
      ...mdCtx,
      handles: [...handles, tagish as BlockHandle<unknown>],
    };
    expect(() =>
      serializeForestToMarkdown([node("tagish", { text: runs("x") })], ctx),
    ).toThrow(/tagish/);
  });
});

describe("headings", () => {
  test("parse `# ` prefix → heading-1", () => {
    const forest = parse("# Title");
    expect(forest[0]!.type).toBe("heading-1");
    expect(dataText(forest[0]!)).toBe("Title");
  });

  test("serialize heading-1 → `# ` prefix", () => {
    expect(serialize([node("heading-1", { text: runs("Title") })])).toBe(
      "# Title",
    );
  });
});

describe("bulleted list", () => {
  test("parses all three CommonMark markers", () => {
    const forest = parse("* a\n- b\n+ c");
    expect(forest.map((b) => b.type)).toEqual([
      "bulleted-list",
      "bulleted-list",
      "bulleted-list",
    ]);
    expect(forest.map(dataText)).toEqual(["a", "b", "c"]);
  });

  test("serializes with the single canonical `* ` prefix", () => {
    expect(serialize([node("bulleted-list", { text: runs("a") })])).toBe("* a");
  });
});

describe("to-do (precedence over bulleted list)", () => {
  test("`- [ ] x` parses as an UNCHECKED to-do, not a bullet", () => {
    const forest = parse("- [ ] task");
    expect(forest[0]!.type).toBe("to-do");
    expect(dataText(forest[0]!)).toBe("task");
    expect((forest[0]!.data as { checked: boolean }).checked).toBe(false);
  });

  test("`- [x] x` parses as a CHECKED to-do", () => {
    const forest = parse("- [x] done");
    expect(forest[0]!.type).toBe("to-do");
    expect((forest[0]!.data as { checked: boolean }).checked).toBe(true);
  });

  test("a plain `- item` still parses as a bullet", () => {
    expect(parse("- item")[0]!.type).toBe("bulleted-list");
  });

  test("serialize both states", () => {
    expect(
      serialize([node("to-do", { text: runs("a"), checked: false })]),
    ).toBe("- [ ] a");
    expect(serialize([node("to-do", { text: runs("a"), checked: true })])).toBe(
      "- [x] a",
    );
  });
});

describe("numbered list", () => {
  test("parses `1.` / `2)` discarding the literal number", () => {
    const forest = parse("1. one\n2) two");
    expect(forest.map((b) => b.type)).toEqual([
      "numbered-list",
      "numbered-list",
    ]);
    expect(forest.map(dataText)).toEqual(["one", "two"]);
  });

  test("serialize numbers sequentially and resets per nesting level", () => {
    const forest: SerializedBlock[] = [
      {
        type: "numbered-list",
        data: { text: runs("one") },
        expanded: true,
        children: [
          node("numbered-list", { text: runs("nested-a") }),
          node("numbered-list", { text: runs("nested-b") }),
        ],
      },
      node("numbered-list", { text: runs("two") }),
    ];
    expect(serialize(forest)).toBe(
      ["1. one", "  1. nested-a", "  2. nested-b", "2. two"].join("\n"),
    );
  });
});

describe("toggle", () => {
  test("round-trips the `> ` prefix", () => {
    const forest = parse("> collapsible");
    expect(forest[0]!.type).toBe("toggle");
    expect(dataText(forest[0]!)).toBe("collapsible");
    expect(serialize([node("toggle", { text: runs("collapsible") })])).toBe(
      "> collapsible",
    );
  });
});

describe("code fence", () => {
  test("parses a multi-line fenced block with a language info string", () => {
    const forest = parse("```ts\nconst x = 1;\nconst y = 2;\n```");
    expect(forest).toHaveLength(1);
    expect(forest[0]!.type).toBe("code-block");
    expect(forest[0]!.data).toEqual({
      code: "const x = 1;\nconst y = 2;",
      language: "ts",
    });
  });

  test("no info string ⇒ no language key", () => {
    const forest = parse("```\nplain\n```");
    expect(forest[0]!.data).toEqual({ code: "plain" });
  });

  test("serialize round-trips code + language", () => {
    expect(
      serialize([node("code-block", { code: "a\nb", language: "ts" })]),
    ).toBe("```ts\na\nb\n```");
  });

  test("a NESTED fence round-trips byte-identically (the dedent fix)", () => {
    // The serializer indents every line of a multi-line block by its depth, so a
    // fence two levels deep arrives at the parser with four columns of leading
    // whitespace on every body line. Pushing the body raw made the code accrete
    // two spaces per cycle — invisible in one round trip, corrupting in a loop.
    const forest: SerializedBlock[] = [
      {
        type: "bulleted-list",
        data: { text: runs("outer") },
        expanded: true,
        children: [
          {
            type: "bulleted-list",
            data: { text: runs("inner") },
            expanded: true,
            children: [
              node("code-block", {
                code: "const x = 1;\nreturn x;",
                language: "ts",
              }),
            ],
          },
        ],
      },
    ];
    const md = serialize(forest);
    expect(md).toBe(
      [
        "* outer",
        "  * inner",
        "    ```ts",
        "    const x = 1;",
        "    return x;",
        "    ```",
      ].join("\n"),
    );
    expect(parse(md)).toEqual(forest);
    // Idempotent, which is the property the raw push broke.
    expect(serialize(parse(md))).toBe(md);
  });

  test("dedent strips UP TO the fence's indent, never more", () => {
    // Genuine leading whitespace inside the code survives: the second body line
    // is indented four columns beyond the fence's own two.
    const md = ["  ```py", "  def f():", "      return 1", "  ```"].join("\n");
    expect(parse(md)[0]!.data).toEqual({
      code: "def f():\n    return 1",
      language: "py",
    });
  });
});

// ---------------------------------------------------------------------------
// Line run: a block with no closing delimiter (the GFM table)
// ---------------------------------------------------------------------------
//
// `markdown.lineRun` is the orchestrator's third claim kind, and the `table`
// block is its declarer. What is under test is the ORCHESTRATOR's half — which
// lines make up a run, what a decline does, how the run ends — so every case
// goes through `parse` / `serialize` over the real registry. The cell grammar
// itself (splitting, the table-level escapes) is `page/table`'s own suite.

describe("line run", () => {
  /** A table node, cells given as plain strings. */
  const table = (
    header: string[],
    rows: string[][] = [],
    align: ("left" | "center" | "right" | null)[] = header.map(() => null),
  ): SerializedBlock =>
    node("table", {
      align,
      header: header.map(runs),
      rows: rows.map((row) => row.map(runs)),
    });

  test("parses a header, a delimiter row and body rows into ONE table", () => {
    const md = ["| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |"].join(
      "\n",
    );
    const forest = parse(md);
    expect(forest).toEqual([
      table(
        ["a", "b"],
        [
          ["1", "2"],
          ["3", "4"],
        ],
      ),
    ]);
    expect(serialize(forest)).toBe(md);
  });

  test("alignment comes from the delimiter row, and is written back canonically", () => {
    const forest = parse("| a | b | c | d |\n|-|:---|---:|:------:|");
    expect(forest).toEqual([
      table(["a", "b", "c", "d"], [], [null, "left", "right", "center"]),
    ]);
    expect(serialize(forest)).toBe(
      "| a | b | c | d |\n| --- | :-- | --: | :-: |",
    );
  });

  test("a pipe inside a cell is escaped, and comes back as a pipe", () => {
    const forest = [table(["a|b"], [["x | y"]])];
    const md = serialize(forest);
    expect(md).toBe("| a\\|b |\n| --- |\n| x \\| y |");
    expect(parse(md)).toEqual(forest);
  });

  test("marks and inline escapes survive inside a cell", () => {
    const forest = [
      node("table", {
        align: [null],
        header: [[{ text: "bold", marks: ["bold"] }]],
        rows: [[runs("a*b \\ c")]],
      }),
    ];
    const md = serialize(forest);
    expect(md).toBe("| **bold** |\n| --- |\n| a\\*b \\\\ c |");
    expect(parse(md)).toEqual(forest);
  });

  test("a pipe inside a PROTECTED span does not split the cell", () => {
    const math: MarkdownContext = {
      ...mdCtx,
      protectedSpans: [/\\\((.+?)\\\)/],
    };
    const md = "| \\(a|b\\) | c |\n| --- | --- |";
    const forest = parseMarkdownToForest(md, math);
    expect(forest).toEqual([table(["\\(a|b\\)", "c"])]);
    expect(serializeForestToMarkdown(forest, math)).toBe(md);
  });

  test("a soft break in a cell is `\\n`, in EVERY dialect", () => {
    const forest = [table(["x\ny"])];
    expect(serialize(forest)).toBe("| x\\ny |\n| --- |");
    expect(parse(serialize(forest))).toEqual(forest);
    // The clipboard dialect writes a real newline for a paragraph's break —
    // inside a cell that would end the row, so the cell keeps the escape.
    expect(serializeForestToMarkdown(forest, pasteCtx)).toBe(
      "| x\\ny |\n| --- |",
    );
  });

  test("ragged rows are padded / truncated to the header's width", () => {
    const forest = parse(
      ["| a | b |", "| --- | --- |", "| 1 |", "| 1 | 2 | 3 |"].join("\n"),
    );
    expect(forest).toEqual([
      table(
        ["a", "b"],
        [
          ["1", ""],
          ["1", "2"],
        ],
      ),
    ]);
    expect(serialize(forest)).toBe(
      ["| a | b |", "| --- | --- |", "| 1 |  |", "| 1 | 2 |"].join("\n"),
    );
  });

  test("a body cell that reads as a delimiter cell is escaped, so it cannot start a table", () => {
    const forest = [table(["h"], [["x"], ["---"]])];
    const md = serialize(forest);
    expect(md).toBe("| h |\n| --- |\n| x |\n| \\--- |");
    expect(parse(md)).toEqual(forest);
  });

  test("no delimiter row ⇒ the run DECLINES and every line is prose", () => {
    const md = "| a | b |\n| c | d |";
    const forest = parse(md);
    expect(forest.map((b) => b.type)).toEqual(["text", "text"]);
    expect(forest.map(dataText)).toEqual(["| a | b |", "| c | d |"]);
    // Lenient parse, canonical serialize: written back, they are escaped.
    expect(serialize(forest)).toBe("\\| a | b |\n\\| c | d |");
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("a declined first line does not stop the table that starts on the next", () => {
    const forest = parse("| stray |\n| a |\n| --- |\n| 1 |");
    expect(forest.map((b) => b.type)).toEqual(["text", "table"]);
    expect(forest[1]).toEqual(table(["a"], [["1"]]));
  });

  test("a paragraph opening with `|` round-trips through the `\\|` escape", () => {
    const forest = [node("text", { text: runs("| not a table") })];
    expect(serialize(forest)).toBe("\\| not a table");
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("a table at a DEEPER indent is a child, not a continuation", () => {
    const md = [
      "| a |",
      "| --- |",
      "| 1 |",
      "  | x |",
      "  | --- |",
      "  | 2 |",
    ].join("\n");
    const forest = parse(md);
    expect(forest).toEqual([
      { ...table(["a"], [["1"]]), children: [table(["x"], [["2"]])] },
    ]);
    expect(serialize(forest)).toBe(md);
  });

  test("two ADJACENT tables stay two: a row followed by a delimiter row starts the next", () => {
    const forest = [
      table(["a", "b"], [["1", "2"]]),
      table(["c"], [["3"], ["4"]]),
      table(["d"]),
      table(["e"]),
    ];
    const md = serialize(forest);
    expect(md).toBe(
      [
        "| a | b |",
        "| --- | --- |",
        "| 1 | 2 |",
        "| c |",
        "| --- |",
        "| 3 |",
        "| 4 |",
        "| d |",
        "| --- |",
        "| e |",
        "| --- |",
      ].join("\n"),
    );
    expect(parse(md)).toEqual(forest);
  });

  test("a table inside a tag body", () => {
    const forest: SerializedBlock[] = [
      {
        type: "context",
        data: {},
        expanded: true,
        children: [
          table(["a"], [["1"]]),
          node("text", { text: runs("after") }),
        ],
      },
    ];
    const md = serialize(forest);
    expect(md).toBe(
      [
        "<human>",
        "  | a |",
        "  | --- |",
        "  | 1 |",
        "  after",
        "</human>",
      ].join("\n"),
    );
    expect(parse(md)).toEqual(forest);
  });

  test("a blank line ends the run", () => {
    const forest = parse("| a |\n| --- |\n\n| 1 |");
    expect(forest.map((b) => b.type)).toEqual(["table", "text", "text"]);
    expect(forest[0]).toEqual(table(["a"]));
    expect(dataText(forest[2]!)).toBe("| 1 |");
  });

  test("a line run is a single-line claim to the escape authority", () => {
    expect(markdownLineClaim("| a | b |", mdCtx)).toBe("table");
    expect(markdownLineClaim("  | a", mdCtx)).toBe("table");
    expect(markdownLineClaim("\\| a | b |", mdCtx)).toBeUndefined();
  });
});

describe("equation", () => {
  test("`$$expr` parses into `expression` (never `text`)", () => {
    const forest = parse("$$x^2 + 1");
    expect(forest[0]!.type).toBe("equation");
    expect(forest[0]!.data).toEqual({ expression: "x^2 + 1" });
    expect("text" in (forest[0]!.data as object)).toBe(false);
  });

  test("serialize reads `expression`", () => {
    expect(serialize([node("equation", { expression: "x^2" })])).toBe("$$x^2");
  });
});

describe("divider (void — no text key)", () => {
  test("`---` parses to an empty payload with NO `text` key", () => {
    const forest = parse("---");
    expect(forest[0]!.type).toBe("divider");
    expect(forest[0]!.data).toEqual({});
    expect("text" in (forest[0]!.data as object)).toBe(false);
  });

  test("serialize emits `---`", () => {
    expect(serialize([node("divider", {})])).toBe("---");
  });
});

describe("nested indentation → tree", () => {
  test("two spaces of indent nest as children", () => {
    const forest = parse("- a\n  - b\n  - c\n- d");
    expect(forest).toHaveLength(2);
    expect(dataText(forest[0]!)).toBe("a");
    expect(forest[0]!.children.map(dataText)).toEqual(["b", "c"]);
    expect(dataText(forest[1]!)).toBe("d");
    expect(forest[1]!.children).toHaveLength(0);
  });
});

describe("prompt (text-bearing, no prefix of its own)", () => {
  test("prompt round-trips through its own tag instead of decaying to `text`", () => {
    // WAS: `serialize` emitted the bare line "ship it", which parsed back as a
    // `text` block — a silent type loss on every cycle.
    const md = serialize([node("prompt", { text: runs("ship it") })]);
    expect(md).toBe("<prompt>ship it</prompt>");
    expect(parse(md)).toEqual([node("prompt", { text: runs("ship it") })]);
  });

  test("a `text` body carries inline marks, and children still nest below it", () => {
    const forest: SerializedBlock[] = [
      {
        type: "prompt",
        data: { text: [{ text: "bold", marks: ["bold" as const] }] },
        expanded: true,
        children: [node("bulleted-list", { text: runs("under") })],
      },
    ];
    const md = serialize(forest);
    expect(md).toBe(["<prompt>**bold**</prompt>", "  * under"].join("\n"));
    expect(parse(md)).toEqual(forest);
  });

  test("leading/trailing whitespace in the text survives the single-line form", () => {
    // The inner text is VERBATIM: dedenting it (as the multi-line body form
    // does) would eat a space the text genuinely carries.
    const forest = [node("prompt", { text: runs("  padded  ") })];
    expect(serialize(forest)).toBe("<prompt>  padded  </prompt>");
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("a soft line break inside the text is the escape, on ONE line", () => {
    // The tag body used to be the ONE place a real newline survived — a
    // multi-line body between the tags, rejoined on parse. That is a second
    // spelling for a soft break, chosen by a condition an agent editing the body
    // cannot see, so the escape applies here like everywhere else.
    const forest = [node("prompt", { text: runs("a\nb") })];
    const md = serialize(forest);
    expect(md).toBe("<prompt>a\\nb</prompt>");
    expect(parse(md)).toEqual(forest);
  });

  test("the multi-line body is still what the `newline` dialect emits", () => {
    // Both dialects pinned, rather than one replaced by the other: the branch
    // stays live for the clipboard, where a person reads the text.
    const humanCtx: MarkdownContext = { ...mdCtx, softBreaks: "newline" };
    const md = serializeForestToMarkdown(
      [node("prompt", { text: runs("a\nb") })],
      humanCtx,
    );
    expect(md).toBe(["<prompt>", "  a", "  b", "</prompt>"].join("\n"));
  });

  test("a mark spanning a soft break survives, which it did not before", () => {
    // The multi-line body put a REAL newline between the tags, and
    // `matchDelimiter` abandons a span at one — so a bold prompt line across a
    // break came back as one unmarked literal run. With the escape there is no
    // newline for the guard to see, so the closing `**` is still found.
    const forest = [
      node("prompt", { text: [{ text: "a\nb", marks: ["bold" as const] }] }),
    ];
    const md = serialize(forest);
    expect(md).toBe("<prompt>**a\\nb**</prompt>");
    expect(parse(md)).toEqual(forest);
  });
});

describe("quote (a void container: its passage is its children)", () => {
  test("a quote carries its children inside its tag, not one line of text", () => {
    // The container model's whole point in markdown: a quoted LIST survives,
    // where the text-bearing form had exactly one line to carry.
    const forest: SerializedBlock[] = [
      {
        type: "quote",
        data: {},
        expanded: true,
        children: [
          node("text", { text: runs("wisdom") }),
          node("bulleted-list", { text: runs("and more") }),
        ],
      },
    ];
    const md = serialize(forest);
    expect(md).toBe(
      ["<quote>", "  wisdom", "  * and more", "</quote>"].join("\n"),
    );
    expect(parse(md)).toEqual(forest);
  });
});

describe("the derived tag: the nine types that used to serialize to a blank line", () => {
  test("a callout keeps its appearance payload AND its children", () => {
    // WAS: `() => ""`. A callout, its tint and everything inside it vanished.
    const forest: SerializedBlock[] = [
      {
        type: "callout",
        // Both appearance fields are strings, so both are plain attributes.
        data: { icon: "info", color: "warning" },
        expanded: true,
        children: [node("text", { text: runs("Watch out.") })],
      },
    ];
    const md = serialize(forest);
    expect(md).toBe(
      [
        '<callout icon="info" color="warning">',
        "  Watch out.",
        "</callout>",
      ].join("\n"),
    );
    expect(parse(md)).toEqual(forest);
  });

  test("string fields are plain attributes; everything else is the JSON `data` blob", () => {
    // An attribute value is a string BOTH ways, so `width="640"` would read back
    // as the string "640" — indistinguishable from a genuinely-string field.
    const forest = [
      node("image", { attachmentId: "att_9f2", width: 640, alt: "a cat" }),
    ];
    expect(serialize(forest)).toBe(
      '<image attachmentId="att_9f2" alt="a cat" data="{\\"width\\":640}"/>',
    );
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("an empty payload is a bare self-closing tag", () => {
    expect(serialize([node("video", {})])).toBe("<video/>");
    expect(parse("<video/>")).toEqual([node("video", {})]);
  });

  test("every previously-dropped type survives a round trip", () => {
    const forest: SerializedBlock[] = [
      node("callout", { icon: null, color: "default" }),
      node("image", { attachmentId: "a1" }),
      node("video", { attachmentId: "a2", mime: "video/mp4" }),
      node("audio", { attachmentId: "a3", mime: "audio/mpeg" }),
      node("file", { attachmentId: "a4", filename: "notes.pdf", size: 12 }),
      node("embed", { url: "https://example.com/e" }),
      node("bookmark", {
        url: "https://example.com",
        title: "Example",
        fetched: true,
        attachmentIds: ["i1", "f1"],
      }),
      node("page-link", { pageId: "p1" }),
    ];
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("attribute values carrying quotes, backslashes and newlines survive", () => {
    const forest = [node("bookmark", { title: 'he said "hi"\\ \n bye' })];
    expect(parse(serialize(forest))).toEqual(forest);
  });
});

describe("annotation containers (a real syntax, not a one-way marker)", () => {
  test("children go INSIDE the tag and come back as the same container", () => {
    const forest: SerializedBlock[] = [
      {
        type: "context",
        data: {},
        expanded: true,
        children: [
          node("heading-1", { text: runs("Conventions") }),
          node("bulleted-list", { text: runs("always run X") }),
        ],
      },
    ];
    const md = serialize(forest);
    expect(md).toBe(
      ["<human>", "  # Conventions", "  * always run X", "</human>"].join("\n"),
    );
    expect(parse(md)).toEqual(forest);
  });

  test("containers nest, depth-counted on the same tag name", () => {
    const forest: SerializedBlock[] = [
      {
        type: "context",
        data: {},
        expanded: true,
        children: [
          {
            type: "context",
            data: {},
            expanded: true,
            children: [node("text", { text: runs("inner") })],
          },
          node("text", { text: runs("outer tail") }),
        ],
      },
    ];
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("a FENCED body inside a container is opaque to the close scan", () => {
    // The code below contains the container's own closing tag. It is code, not
    // structure, so the scan must skip fenced regions or the container closes
    // early and the rest of its content spills out.
    const forest: SerializedBlock[] = [
      {
        type: "context",
        data: {},
        expanded: true,
        children: [
          node("code-block", { code: 'print("</human>")', language: "py" }),
          node("text", { text: runs("after the code") }),
        ],
      },
    ];
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("a container's `typingPrefixes` are invisible to the parser — `TODO ` in prose is prose", () => {
    // Nothing in this module reads `typingPrefixes`, and the tag pass keys on
    // the tag NAME. So a pasted line that happens to start with the wrap trigger
    // stays a paragraph.
    const forest = parse("TODO write the docs");
    expect(forest[0]!.type).toBe("text");
    expect(dataText(forest[0]!)).toBe("TODO write the docs");
  });
});

// ---------------------------------------------------------------------------
// The identified tag: an ADDRESSABLE region
// ---------------------------------------------------------------------------
//
// `markdown.tag.identified` carries the block's ROW id as the reserved `id`
// attribute, both ways: out of `ctx.id`, back onto `SerializedBlock.ref`. What
// it buys is a document whose reader can point at a card and be understood. What
// it must never do is let that id reach `data`, or reach the clipboard's
// id-minting path — the two failure modes each case below pins.

describe("identified tags (the row id, both ways)", () => {
  const withId = (
    id: string,
    type: string,
    data: unknown,
    children: MarkdownNode[] = [],
  ): MarkdownNode => ({ id, type, data, expanded: true, children });

  test("the row id is emitted as the FIRST attribute and comes back as `ref`", () => {
    const md = serializeForestToMarkdown(
      [
        withId("block-card", "agent-note", {}, [
          withId("c1", "text", { text: runs("found it") }),
        ]),
      ],
      mdCtx,
    );
    expect(md).toBe(
      ['<agent-inline id="block-card">', "  found it", "</agent-inline>"].join(
        "\n",
      ),
    );
    expect(parse(md)).toEqual([
      {
        type: "agent-note",
        data: {},
        expanded: true,
        ref: "block-card",
        children: [node("text", { text: runs("found it") })],
      },
    ]);
  });

  test("the id never lands in `data` — the card's payload stays void", () => {
    // The whole reason the attribute is lifted OFF the record before `dataOf`.
    // `z.object({})` would have STRIPPED it, leaving the tag decorative: the
    // document would say which card it means and nothing downstream would hear.
    const parsed = parse('<agent-inline id="block-card"/>')[0]!;
    expect(parsed.data).toEqual({});
    expect(parsed.ref).toBe("block-card");
  });

  test("an id-less card serializes BARE and parses with no `ref` key at all", () => {
    // The clipboard case, and the "mint me a card" case — one syntax, and it is
    // deliberately not an error the way an id-less `<page/>` is.
    const forest: SerializedBlock[] = [
      {
        type: "agent-note",
        data: {},
        expanded: true,
        children: [node("text", { text: runs("fresh") })],
      },
    ];
    const md = serialize(forest);
    expect(md).toBe(
      ["<agent-inline>", "  fresh", "</agent-inline>"].join("\n"),
    );
    const parsed = parse(md);
    expect(parsed).toEqual(forest);
    // Structurally absent, not `ref: undefined` — `toEqual` would accept either.
    expect("ref" in parsed[0]!).toBe(false);
  });

  test("an EMPTY id is the same as no id", () => {
    const parsed = parse('<agent-inline id=""/>')[0]!;
    expect("ref" in parsed).toBe(false);
  });

  test("a non-identified sibling annotation carries no id, in or out", () => {
    // `identified` is opt-in per type. The agent-facing cards all take it — an
    // agent editing around one has to echo its id back exactly — and
    // `<private-note>`, which no agent ever reads, stays content-addressed: the
    // row id is not emitted…
    expect(
      serializeForestToMarkdown([withId("block-x", "private-note", {})], mdCtx),
    ).toBe("<private-note/>");
    // …and one written by hand is SILENTLY DROPPED by the void schema, yielding
    // no `ref`. That is exactly the failure `identified` exists to close, stated
    // as a fact rather than left to be rediscovered: without the opt-in the
    // attribute is decorative, and a card would be re-paired by content alone.
    const parsed = parse('<private-note id="block-x"/>')[0]!;
    expect(parsed.data).toEqual({});
    expect("ref" in parsed).toBe(false);
  });

  test("the identified type set is derivable from the registry, never named", () => {
    // What the markdown-apply planner reads, so it can pin a `ref` without ever
    // naming a block type (and so a rename cannot silently stop the pinning).
    // `page` is in it through its `<agent-page>` spelling alone: any spelling
    // that round-trips a row id makes the type identified.
    //
    // Sorted, because the registry's own order is its plugins' ids — moving a
    // plugin would reorder this list without changing anything it is about.
    expect(
      handles
        .filter(markdownTagIsIdentified)
        .map((h) => h.type)
        .sort(),
    ).toEqual(["agent-note", "context", "instructions", "page", "todo"]);
  });

  test("a handle declaring `identified` beside an `id` field is a LOUD failure", () => {
    // The derived projection would emit `data.id` under the reserved name, and
    // the row ref and the payload field would fight. Caught at resolution, which
    // is the first time anything serializes or parses this type.
    const clashing = defineBlock({
      type: "clashing",
      schema: z.object({ id: z.string() }),
      empty: () => ({ id: "" }),
      markdown: { tag: { body: "children", identified: true } },
    }) as BlockHandle<unknown>;
    expect(() => markdownTagIsIdentified(clashing)).toThrow(
      /reserves the `id` attribute/,
    );
  });

  test("minting ids ignores a node's `ref` — paste can never reuse a live row", () => {
    // `withMintedIds` is shared with clipboard paste. A card copied out of a page
    // and pasted back arrives carrying the ORIGINAL card's row id in `ref`; the
    // mint must still produce a fresh identity, and merely carry the ref through.
    const [minted] = withMintedIds(parse('<agent-inline id="block-card"/>'));
    expect(minted!.id).not.toBe("block-card");
    expect(minted!.ref).toBe("block-card");
  });
});

// ---------------------------------------------------------------------------
// Annotated tags: attributes whose value lives in ANOTHER table
// ---------------------------------------------------------------------------
//
// `markdown.tag.annotated` is `identified` generalized to a declared SET of
// names. What it buys is a document that can state a fact about a block the
// block does not own — a TODO card's linked task and that task's status — which
// no projection of `data` could produce. What it must never do is let one of
// those names reach `data` on the way back in, which is what makes the round
// trip closed: the same card, re-parsed, is byte-for-byte the card that was
// there before anything was dispatched from it.

describe("annotated tags (facts the block does not own)", () => {
  const annotated = (
    type: string,
    data: unknown,
    annotations: Record<string, string>,
    children: MarkdownNode[] = [],
    id?: string,
  ): MarkdownNode => ({
    ...(id === undefined ? {} : { id }),
    type,
    data,
    annotations,
    expanded: true,
    children,
  });

  test("annotations are emitted, and parse gives back the UN-annotated card", () => {
    const md = serializeForestToMarkdown(
      [
        annotated("todo", {}, { task_id: "task-7", status: "in_progress" }, [
          node("text", { text: runs("fix the parser") }),
        ]),
      ],
      mdCtx,
    );
    expect(md).toBe(
      [
        '<todo task_id="task-7" status="in_progress">',
        "  fix the parser",
        "</todo>",
      ].join("\n"),
    );
    // The attributes come OFF before `dataOf`, so the payload stays void — the
    // void `z.object({})` would otherwise have stripped them silently, and a
    // strict schema would have rejected a document this side emitted itself.
    const parsed = parse(md);
    expect(parsed).toEqual([
      {
        type: "todo",
        data: {},
        expanded: true,
        children: [node("text", { text: runs("fix the parser") })],
      },
    ]);
    // …which is byte-for-byte what the SAME card with no task parses to. That
    // equality is the point: dispatching an agent changes what the card SAYS
    // without changing what it IS, so the next apply reads no edit at all.
    expect(parsed).toEqual(
      parse(["<todo>", "  fix the parser", "</todo>"].join("\n")),
    );
  });

  test("reserved attributes come first: `id`, then annotations, then the type's own", () => {
    // One tag with all three sources, so the ORDER is pinned in one place rather
    // than inferred from two tags that each show half of it.
    const dispatchCard = defineBlock({
      type: "dispatch-card",
      schema: z.object({ label: z.string() }),
      empty: () => ({ label: "" }),
      markdown: {
        tag: {
          body: "children",
          identified: true,
          annotated: ["task_id", "status"],
        },
      },
    }) as BlockHandle<unknown>;
    const ctx: MarkdownContext = {
      handles: [...handles, dispatchCard],
      protectedSpans: [],
      blankLines: "empty-block",
      emptyBlocks: "pinned",
      softBreaks: "escaped",
    };
    const md = serializeForestToMarkdown(
      [
        annotated(
          "dispatch-card",
          { label: "ship it" },
          { task_id: "t1", status: "done" },
          [],
          "block-9",
        ),
      ],
      ctx,
    );
    expect(md).toBe(
      '<dispatch-card id="block-9" task_id="t1" status="done" label="ship it"/>',
    );
    expect(parseMarkdownToForest(md, ctx)).toEqual([
      {
        type: "dispatch-card",
        data: { label: "ship it" },
        expanded: true,
        ref: "block-9",
        children: [],
      },
    ]);
  });

  test("an absent value omits its attribute — a card nobody dispatched is bare", () => {
    // The clipboard case, and the ordinary case: a TODO with no task has no
    // task_id, and an empty attribute would be a lie about a row that does not
    // exist. Annotations are declared per TYPE, supplied per NODE.
    expect(serialize([node("todo", {})])).toBe("<todo/>");
    expect(
      serializeForestToMarkdown(
        [annotated("todo", {}, { status: "held" })],
        mdCtx,
      ),
    ).toBe('<todo status="held"/>');
  });

  test("an `annotated` name colliding with a schema field is a LOUD failure", () => {
    const clashing = defineBlock({
      type: "clashing-field",
      schema: z.object({ status: z.string() }),
      empty: () => ({ status: "" }),
      markdown: { tag: { body: "children", annotated: ["status"] } },
    }) as BlockHandle<unknown>;
    // `markdownTagIsIdentified` merely RESOLVES the tag — which is the first
    // thing any serialize or parse of this type does.
    expect(() => markdownTagIsIdentified(clashing)).toThrow(
      /reserves the `status` attribute/,
    );
  });

  test("`data` and (on an identified tag) `id` are reserved against annotations too", () => {
    const overData = defineBlock({
      type: "clashing-data",
      schema: z.object({}),
      empty: () => ({}),
      markdown: { tag: { body: "children", annotated: ["data"] } },
    }) as BlockHandle<unknown>;
    expect(() => markdownTagIsIdentified(overData)).toThrow(/JSON-encodes/);

    const overId = defineBlock({
      type: "clashing-id",
      schema: z.object({}),
      empty: () => ({}),
      markdown: {
        tag: { body: "children", identified: true, annotated: ["id"] },
      },
    }) as BlockHandle<unknown>;
    expect(() => markdownTagIsIdentified(overId)).toThrow(
      /already reserved by/,
    );
  });

  test("a type whose own `attrs` emits a reserved annotated name throws at serialize", () => {
    // The half only a function body knows, so it cannot be caught at resolution
    // — and it fires whether or not a value was supplied for this node, since
    // the conflict is in the declaration, not in one document.
    const doubled = defineBlock({
      type: "doubled",
      schema: z.object({}),
      empty: () => ({}),
      markdown: {
        tag: {
          body: "children",
          annotated: ["status"],
          attrs: () => ({ status: "mine" }),
        },
      },
    }) as BlockHandle<unknown>;
    const ctx: MarkdownContext = {
      handles: [...handles, doubled],
      protectedSpans: [],
      blankLines: "empty-block",
      emptyBlocks: "pinned",
      softBreaks: "escaped",
    };
    expect(() => serializeForestToMarkdown([node("doubled", {})], ctx)).toThrow(
      /own `attrs` emitted one too/,
    );
  });

  test("a node carrying an UNDECLARED annotation throws rather than emitting it", () => {
    // Emitting it would make it a `data` key on the way back in (nothing
    // reserves it, so the strip never sees it); dropping it would make a fact
    // its supplier believes is in the document silently absent.
    expect(() =>
      serializeForestToMarkdown(
        [annotated("todo", {}, { priority: "high" })],
        mdCtx,
      ),
    ).toThrow(/does not declare in `markdown.tag.annotated`/);
  });

  test("a LINE-serialized type cannot carry an annotation either", () => {
    // Same refusal at the other branch: a paragraph has no attribute list, so
    // there is nowhere for the value to go and no tag that could declare it.
    expect(() =>
      serializeForestToMarkdown(
        [annotated("text", { text: runs("plain") }, { status: "done" })],
        mdCtx,
      ),
    ).toThrow(/serializes as markdown LINES/);
  });
});

// ---------------------------------------------------------------------------
// A typing shortcut is NOT markdown line syntax
// ---------------------------------------------------------------------------
//
// The executable statement of why `BlockHandle` carries two prefix fields. Every
// case below is a prefix a user can TYPE to convert a block, whose markdown
// meaning is something else entirely (or nothing at all) — so the clipboard
// pipeline must not claim it.

describe("typingPrefixes never reach the markdown pipeline", () => {
  test("a markdown TABLE body does not become quote blocks", () => {
    // `quote` WRAPS the line on a typed `| ` (a container's typed prefix is a
    // wrap), and `| ` is exactly a table row's opening in markdown. Had it been a
    // `markdownPrefixes` entry, `derivedParsePrefixes` would claim both lines and
    // the pasted table would arrive as two quotes with the pipes eaten. The
    // lines belong to the `table` block's line run instead: one table, no quote.
    const forest = parse(["| a | b |", "| - | - |"].join("\n"));
    expect(forest.map((b) => b.type)).toEqual(["table"]);
    expect(forest[0]!.data).toEqual({
      align: [null, null],
      header: [runs("a"), runs("b")],
      rows: [],
    });
  });

  test("`| ` is a conversion prefix but not a markdown one", () => {
    expect(conversionPrefixesOf(byType("quote"))).toEqual(["| "]);
    expect(byType("quote").markdownPrefixes).toBeUndefined();
  });

  test("markdown syntax is ALSO a typing shortcut — the union is a superset", () => {
    // A `markdownPrefixes` entry needs no restating: anything the parser claims
    // is by definition something the user can type.
    expect(conversionPrefixesOf(byType("bulleted-list"))).toEqual([
      "* ",
      "- ",
      "+ ",
    ]);
    // …while a type carrying only input-only entries hands back exactly those.
    expect(conversionPrefixesOf(byType("to-do"))).toEqual(["[] ", "[ ] "]);
    // Ordering when a type declares BOTH: markdown syntax first, input-only after.
    const both = defineBlock({
      type: "both",
      schema: textDataSchema,
      empty: () => ({ text: [] }),
      markdownPrefixes: ["# "],
      typingPrefixes: ["! "],
    });
    expect(conversionPrefixesOf(both as BlockHandle<unknown>)).toEqual([
      "# ",
      "! ",
    ]);
  });

  test("a to-do's `[] ` shorthand is typing-only: pasted, it stays prose", () => {
    // The markdown task-list syntax is `- [ ] `, which `to-do`'s own `parseLine`
    // owns. The bare `[] ` shorthand exists for the keyboard alone.
    const forest = parse("[] buy milk");
    expect(forest[0]!.type).toBe("text");
    expect(dataText(forest[0]!)).toBe("[] buy milk");
  });
});

describe("page tags", () => {
  const identified = (
    id: string,
    type: string,
    data: unknown,
    children: MarkdownNode[] = [],
    expanded = true,
  ): MarkdownNode => ({ id, type, data, expanded, children });

  test("an EXPANDED sub-page emits its children; a COLLAPSED one self-closes", () => {
    const data = { title: "Sub", icon: null };
    const child = identified("c1", "text", { text: runs("inside") });
    expect(
      serializeForestToMarkdown(
        [identified("p1", "page", data, [child])],
        mdCtx,
      ),
    ).toBe(['<page id="p1">', "  inside", "</page>"].join("\n"));
    expect(
      serializeForestToMarkdown(
        [identified("p1", "page", data, [child], false)],
        mdCtx,
      ),
    ).toBe('<page id="p1"/>');
  });

  test("`expanded` is a page-tag rule ONLY — a collapsed toggle still emits its children", () => {
    const forest: SerializedBlock[] = [
      {
        type: "toggle",
        data: { text: runs("folded") },
        expanded: false,
        children: [node("text", { text: runs("hidden but copied") })],
      },
    ];
    expect(serialize(forest)).toBe(
      ["> folded", "  hidden but copied"].join("\n"),
    );
  });

  test("a sub-page needs its row id — an id-less forest fails LOUDLY", () => {
    expect(() =>
      serialize([node("page", { title: "Sub", icon: null })]),
    ).toThrow(/IDENTIFIED forest/);
  });

  test("markdown parse alone can never mint a HUMAN's sub-page: `<page/>` is a page-link", () => {
    expect(parse('<page id="p1"/>')).toEqual([
      node("page-link", { pageId: "p1" }),
    ]);
  });

  test("a BODY on a parsed page tag is a loud rejection, never a silent drop", () => {
    expect(() =>
      parse(['<page id="p1">', "  smuggled", "</page>"].join("\n")),
    ).toThrow(/takes no body/);
    expect(() => parse('<page id="p1"></page>')).toThrow(/takes no body/);
  });

  test("a page tag with no id is a loud rejection", () => {
    expect(() => parse("<page/>")).toThrow(/needs an `id`/);
  });
});

describe("page spellings: `<page>` and `<agent-page>` are one row type", () => {
  const identified = (
    id: string,
    type: string,
    data: unknown,
    children: MarkdownNode[] = [],
    expanded = true,
  ): MarkdownNode => ({ id, type, data, expanded, children });
  const human = { title: "Mental model", icon: null };
  const agent = { title: "Findings", icon: null, author: "agent" as const };

  test("the row's data picks the spelling on serialize", () => {
    expect(
      serializeForestToMarkdown(
        [identified("p1", "page", human, [], false)],
        mdCtx,
      ),
    ).toBe('<page id="p1"/>');
    expect(
      serializeForestToMarkdown(
        [identified("p2", "page", agent, [], false)],
        mdCtx,
      ),
    ).toBe('<agent-page id="p2" title="Findings"/>');
  });

  test("an EXPANDED agent page emits its body inside its own tag", () => {
    const child = identified("c1", "text", { text: runs("inside") });
    expect(
      serializeForestToMarkdown(
        [identified("p2", "page", agent, [child])],
        mdCtx,
      ),
    ).toBe(
      [
        '<agent-page id="p2" title="Findings">',
        "  inside",
        "</agent-page>",
      ].join("\n"),
    );
  });

  test("the MINT form parses to a new page node carrying `author` and its body", () => {
    const [minted] = parse(
      [
        '<agent-page title="Findings">',
        "  first line",
        "  - a bullet",
        "</agent-page>",
      ].join("\n"),
    );
    expect(minted).toEqual({
      type: "page",
      data: agent,
      expanded: true,
      children: [
        node("text", { text: runs("first line") }),
        node("bulleted-list", { text: runs("a bullet") }),
      ],
    });
    // No id, so no `ref` KEY at all: this is a document asking for a new page.
    expect("ref" in minted!).toBe(false);
  });

  test("a POINTER parses to a `ref` on the page node — the id never reaches `data`", () => {
    const [pointer] = parse('<agent-page id="p2" title="Findings"/>');
    expect(pointer).toEqual({ ...node("page", agent), ref: "p2" });
  });

  test("an untitled mint is an untitled page, not an error", () => {
    expect(parse("<agent-page/>")).toEqual([
      node("page", { title: "", icon: null, author: "agent" }),
    ]);
  });

  test("any attribute but `title` is a LOUD rejection naming where the content lives", () => {
    expect(() =>
      parse('<agent-page id="p2" title="x" icon="rocket"/>'),
    ).toThrow(/takes only `title`[\s\S]*pass its id as `block_id`/);
    // The preset key too: the NAME says whose page it is, an attribute cannot.
    expect(() => parse('<agent-page title="x" author="agent"/>')).toThrow(
      /takes only `title`/,
    );
  });

  test("`<page>` carries an ANNOTATED title — emitted, then dropped on parse", () => {
    // The sub-page shell's title and a link's target title are both supplied by
    // a reader (the server's `Editor.BlockAnnotation` providers), never read off
    // `data` — `page-link` owns the tag on parse and its title lives elsewhere.
    expect(
      serializeForestToMarkdown(
        [
          {
            ...identified("p1", "page", human, [], false),
            annotations: { title: "Mental model" },
          },
          {
            ...identified("l1", "page-link", { pageId: "p9" }),
            annotations: { title: "Elsewhere" },
          },
        ],
        mdCtx,
      ),
    ).toBe(
      [
        '<page id="p1" title="Mental model"/>',
        '<page id="p9" title="Elsewhere"/>',
      ].join("\n"),
    );
    // Read-only: the value is discarded, whatever it says.
    expect(parse('<page id="p9" title="edited by an agent"/>')).toEqual([
      node("page-link", { pageId: "p9" }),
    ]);
  });

  test("`<agent-page>` KEEPS its title on parse — it is the row's own data", () => {
    expect(parse('<agent-page id="p2" title="Renamed?"/>')[0]!.data).toEqual({
      ...agent,
      title: "Renamed?",
    });
  });

  test("an agent page handed a `title` ANNOTATION throws — its spelling does not reserve one", () => {
    // The server's page-title provider skips agent pages for exactly this reason;
    // if it ever stopped, this is the loud failure instead of a doubled attribute.
    expect(() =>
      serializeForestToMarkdown(
        [
          {
            ...identified("p2", "page", agent, [], false),
            annotations: { title: "x" },
          },
        ],
        mdCtx,
      ),
    ).toThrow(/does not declare in `markdown.tag.annotated`/);
  });

  test("the registry answers per spelling: names, the row's name, identity, authorship", () => {
    expect(markdownParseTagNames(byType("page"))).toEqual([
      "agent-page",
      "instructions-page",
    ]);
    expect(markdownParseTagNames(byType("page-link"))).toEqual(["page"]);
    expect(markdownTagNameOf(byType("page"), human)).toBe("page");
    expect(markdownTagNameOf(byType("page"), agent)).toBe("agent-page");
    // Identified through `<agent-page>` alone — the primary is not.
    expect(markdownTagIsIdentified(byType("page"))).toBe(true);
    const agentTags = markdownTagNamesAuthoredBy(handles, "agent");
    expect(agentTags).toContain("agent-page");
    expect(agentTags).not.toContain("page");
  });
});

describe("page spellings: `<instructions-page>` is a pointer an agent cannot mint", () => {
  const instructions = {
    title: "Track rules",
    icon: null,
    instructions: true as const,
  };

  test("an instructions page serializes under its own spelling, `global` only when true", () => {
    const n = (data: unknown): MarkdownNode => ({
      id: "p3",
      type: "page",
      data,
      expanded: false,
      children: [],
    });
    expect(serializeForestToMarkdown([n(instructions)], mdCtx)).toBe(
      '<instructions-page id="p3" title="Track rules"/>',
    );
    expect(
      serializeForestToMarkdown([n({ ...instructions, global: true })], mdCtx),
    ).toBe('<instructions-page id="p3" title="Track rules" global="true"/>');
  });

  test("a POINTER reads back as the same page row, `global` included", () => {
    expect(
      parse('<instructions-page id="p3" title="Track rules" global="true"/>'),
    ).toEqual([
      { ...node("page", { ...instructions, global: true }), ref: "p3" },
    ]);
  });

  test("the tagless MINT form is a loud refusal — only a person makes one", () => {
    expect(() => parse('<instructions-page title="x"/>')).toThrow(
      /without an `id`[\s\S]*only a person creates one/,
    );
    expect(() =>
      parse(
        [
          '<instructions-page title="x">',
          "  body",
          "</instructions-page>",
        ].join("\n"),
      ),
    ).toThrow(/without an `id`/);
  });

  test("an instructions page declares the HUMAN, so it is closed inside an agent page", () => {
    expect(markdownTagNameOf(byType("page"), instructions)).toBe(
      "instructions-page",
    );
    expect(markdownTagNamesAuthoredBy(handles, "human")).toContain(
      "instructions-page",
    );
    expect(markdownTagNamesAuthoredBy(handles, "agent")).not.toContain(
      "instructions-page",
    );
  });

  test("unknown attributes and a non-boolean `global` are refused", () => {
    expect(() =>
      parse('<instructions-page id="p3" title="x" icon="rocket"/>'),
    ).toThrow(/takes only `id`, `title` and `global`/);
    expect(() =>
      parse('<instructions-page id="p3" title="x" global="yes"/>'),
    ).toThrow(/`global` is "true" or absent/);
  });
});

describe("tag spellings: resolution refuses what could not read back", () => {
  const flagSchema = z.object({
    kind: z.string().optional(),
    note: z.string().optional(),
  });
  /** A handle whose PRIMARY is claimable, so a primary parse can be asserted. */
  const flagWith = (
    spellings: { name: string; data: Record<string, unknown> }[],
  ) =>
    defineBlock({
      type: "flag",
      schema: flagSchema,
      empty: () => ({}),
      markdown: {
        tag: {
          name: "flag",
          body: "none",
          // Cast: the refusals below ARE presets the type would reject, and the
          // point is that resolution refuses them at runtime too.
          spellings: spellings.map((s) => ({
            ...s,
            body: "none" as const,
          })) as BlockTagSpelling<z.infer<typeof flagSchema>>[],
        },
      },
    }) as BlockHandle<unknown>;
  const ctxWith = (h: BlockHandle<unknown>): MarkdownContext => ({
    ...mdCtx,
    // The REAL default-text handle plus the fixture: the refusals below are
    // about the fixture's own declaration, and a paragraph type has to be there
    // for a line to fall through to.
    handles: [byType("text"), h],
  });

  test("a spelling round-trips, and its preset keys are not re-emitted as attributes", () => {
    const flag = flagWith([{ name: "flag-x", data: { kind: "x" } }]);
    const md = serializeForestToMarkdown(
      [
        {
          type: "flag",
          data: { kind: "x", note: "hi" },
          expanded: true,
          children: [],
        },
      ],
      ctxWith(flag),
    );
    expect(md).toBe('<flag-x note="hi"/>');
    expect(parseMarkdownToForest(md, ctxWith(flag))).toEqual([
      node("flag", { kind: "x", note: "hi" }),
    ]);
  });

  test("a PRIMARY parse that lands on a spelling's preset throws", () => {
    const flag = flagWith([{ name: "flag-x", data: { kind: "x" } }]);
    expect(() =>
      parseMarkdownToForest('<flag kind="x"/>', ctxWith(flag)),
    ).toThrow(/written as <flag-x>/);
    expect(parseMarkdownToForest('<flag kind="y"/>', ctxWith(flag))).toEqual([
      node("flag", { kind: "y" }),
    ]);
  });

  test("a duplicate name — or the primary's own — is refused", () => {
    for (const spellings of [
      [
        { name: "flag-x", data: { kind: "x" } },
        { name: "flag-x", data: { kind: "y" } },
      ],
      [{ name: "flag", data: { kind: "x" } }],
    ]) {
      expect(() => markdownParseTagNames(flagWith(spellings))).toThrow(/twice/);
    }
  });

  test("a preset key the schema does not declare is refused", () => {
    expect(() =>
      markdownParseTagNames(
        flagWith([{ name: "flag-x", data: { colour: "red" } }]),
      ),
    ).toThrow(/does not declare/);
  });

  test("an EMPTY preset and a non-literal one are refused", () => {
    expect(() =>
      markdownParseTagNames(flagWith([{ name: "flag-x", data: {} }])),
    ).toThrow(/EMPTY preset/);
    expect(() =>
      markdownParseTagNames(
        flagWith([{ name: "flag-x", data: { kind: ["x"] } }]),
      ),
    ).toThrow(/non-literal/);
  });
});

describe("empty paragraphs", () => {
  const empty = (): SerializedBlock => node("text", { text: [] });

  test("an empty text block emits a blank line and comes back", () => {
    const forest = [
      node("text", { text: runs("a") }),
      empty(),
      node("text", { text: runs("b") }),
    ];
    expect(serialize(forest)).toBe("a\n\nb");
    expect(parse("a\n\nb")).toEqual(forest);
  });

  test("`<text/>` still parses, so documents written before this keep working", () => {
    // Nothing EMITS it in this position (the empty paragraph sits between two
    // siblings, which a blank line states exactly), but it is the one spelling
    // of an empty paragraph that survives a position a blank line cannot state,
    // and every document written before the blank-line dialect uses it.
    expect(parse("a\n<text/>\nb")).toEqual([
      node("text", { text: runs("a") }),
      empty(),
      node("text", { text: runs("b") }),
    ]);
  });

  // -------------------------------------------------------------------------
  // The pin: three positions a blank line cannot state
  // -------------------------------------------------------------------------
  //
  // A blank line carries no indentation of its own, so the parser places it by
  // the block that FOLLOWS it and drops a run with nothing after it. Under
  // `emptyBlocks: "pinned"` the serializer spells exactly those three positions
  // as the handle's tag instead — the FIRST of a sibling list, the LAST of one,
  // and one carrying CHILDREN — so what the agent-facing dialect emits reads
  // back as the very same forest.

  test("pinned: an empty paragraph FIRST in its sibling list", () => {
    const forest = [empty(), node("text", { text: runs("a") })];
    expect(serialize(forest)).toBe("<text/>\na");
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("pinned: an empty paragraph LAST in its sibling list", () => {
    const forest = [node("text", { text: runs("a") }), empty()];
    expect(serialize(forest)).toBe("a\n<text/>");
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("pinned: an empty paragraph that is BOTH — the only node in its list", () => {
    // Inside a container body, so the drop it replaces is the tag-body edge one
    // rather than the document edge.
    const forest = [
      { type: "quote", data: {}, expanded: true, children: [empty()] },
    ];
    expect(serialize(forest)).toBe("<quote>\n  <text/>\n</quote>");
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("pinned: an empty paragraph WITH CHILDREN keeps them under the tag", () => {
    // The case with no coverage before the pin, and the one most likely to be
    // got wrong: the pin replaces the LINE only. Routing it through the tag
    // branch would self-close a `body: "none"` tag and silently DELETE the
    // children — so assert explicitly that they are still there, still nested,
    // in both directions.
    const forest = [
      node("text", { text: runs("before") }),
      {
        ...empty(),
        children: [
          node("text", { text: runs("kid one") }),
          node("bulleted-list", { text: runs("kid two") }),
        ],
      },
      node("text", { text: runs("after") }),
    ];
    expect(serialize(forest)).toBe(
      ["before", "<text/>", "  kid one", "  * kid two", "after"].join("\n"),
    );
    const back = parse(serialize(forest));
    expect(back).toEqual(forest);
    // Stated separately, because `toEqual` over the whole forest would still
    // pass if BOTH sides had lost the children.
    expect(back[1]!.children.map(dataText)).toEqual(["kid one", "kid two"]);
  });

  // -------------------------------------------------------------------------
  // A blank line an AGENT writes beside a tag line is spacing
  // -------------------------------------------------------------------------
  //
  // Tags sit on lines of their own, so a blank line beside one states nothing a
  // reader can see — and it is the line anyone writing markdown puts around a
  // card they insert. Read as an empty paragraph it minted a block in the page's
  // prose, OUTSIDE the card being written, and edit_page refused the edit.

  const spaced = (md: string): string => dropBlankLinesBesideTags(md, handles);

  test("blank lines around an inserted card are dropped from agent text", () => {
    const md = [
      "</human>",
      "",
      "<agent-inline>",
      "Noted",
      "",
      "More",
      "</agent-inline>",
      "",
      "",
      "Outro",
    ].join("\n");
    expect(spaced(md)).toBe(
      [
        "</human>",
        "<agent-inline>",
        "Noted",
        "",
        "More",
        "</agent-inline>",
        "Outro",
      ].join("\n"),
    );
  });

  test("a blank line between two paragraphs is kept, and so is a fence body", () => {
    expect(spaced("a\n\nb")).toBe("a\n\nb");
    const fence = "```\n<quote>\n\n</quote>\n```";
    expect(spaced(fence)).toBe(fence);
  });

  test("a name that is not a registered tag is not a tag line", () => {
    expect(spaced("a\n\n<not-a-block>")).toBe("a\n\n<not-a-block>");
  });

  // -------------------------------------------------------------------------
  // A backticked bare id an AGENT writes is the id, so it lands as its chip
  // -------------------------------------------------------------------------

  // A stand-in for a family declaring `agentCodeSpan: "token"` — the real ones
  // are id kinds this core cannot import.
  const ID = /(?<![\w/-])task-\d+-[a-z0-9]+(?![\w/-])/g;
  const unwrapped = (md: string, replaced = ""): string =>
    unwrapAgentCodeSpans(md, handles, [ID], replaced);

  test("a code span holding exactly one id loses its backticks", () => {
    expect(
      unwrapped("filed as `task-1791474346624-bc04eo`, then `task-1-ab`."),
    ).toBe("filed as task-1791474346624-bc04eo, then task-1-ab.");
  });

  test("a span holding more than the id, or no id, stays code", () => {
    const md =
      "`task-1-ab done` and `foo.ts` and ``task-1-ab`` and \\`task-1-ab`";
    expect(unwrapped(md)).toBe(md);
  });

  test("a span already in the replaced text is carried over as written", () => {
    expect(unwrapped("- `task-1-ab` and `task-2-cd`", "- `task-1-ab`")).toBe(
      "- `task-1-ab` and task-2-cd",
    );
  });

  test("a fence body is verbatim", () => {
    const fence = "```\n`task-1-ab`\n```";
    expect(unwrapped(fence)).toBe(fence);
  });

  test("the PARSER still reads a blank line beside a tag as an empty paragraph", () => {
    // A spacer already on the page must survive an agent inserting a card beside
    // it — so the spacing rule is for the agent's text only, never the parse.
    expect(parse("a\n<quote>\n  q\n</quote>\n\nb").map((b) => b.type)).toEqual([
      "text",
      "quote",
      "text",
      "text",
    ]);
  });

  test("pinned: an empty paragraph BESIDE a card is spelled <text/>", () => {
    const card = {
      type: "quote",
      data: {},
      expanded: true,
      children: [node("text", { text: runs("q") })],
    };
    const forest = [
      node("text", { text: runs("a") }),
      empty(),
      card,
      empty(),
      empty(),
      node("text", { text: runs("b") }),
    ];
    expect(serialize(forest)).toBe(
      [
        "a",
        "<text/>",
        "<quote>",
        "  q",
        "</quote>",
        "<text/>",
        "<text/>",
        "b",
      ].join("\n"),
    );
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("pinned: a card ending a nested list pins the empty paragraph after its parent", () => {
    const forest = [
      {
        ...node("text", { text: runs("parent") }),
        children: [
          {
            type: "quote",
            data: {},
            expanded: true,
            children: [node("text", { text: runs("q") })],
          },
        ],
      },
      empty(),
      node("text", { text: runs("b") }),
    ];
    const md = serialize(forest);
    expect(md).toBe(
      ["parent", "  <quote>", "    q", "  </quote>", "<text/>", "b"].join("\n"),
    );
    expect(parse(md)).toEqual(forest);
  });

  test("an empty paragraph BETWEEN two siblings is still a blank line", () => {
    // The pin is narrow on purpose: a blank line states this position exactly,
    // and it is what makes the projection read as prose.
    const forest = [
      node("text", { text: runs("a") }),
      empty(),
      node("text", { text: runs("b") }),
    ];
    expect(serialize(forest)).toBe("a\n\nb");
  });

  test("the `blank-line` dialect never pins — a human paste sees no tag", () => {
    // What `clipboard-write.ts` declares. The loss is real and taken knowingly:
    // the copy is worth something in another app, and the internal round trip
    // goes through the structural clipboard flavour.
    const humanCtx: MarkdownContext = { ...mdCtx, emptyBlocks: "blank-line" };
    expect(
      serializeForestToMarkdown(
        [empty(), node("text", { text: runs("a") })],
        humanCtx,
      ),
    ).toBe("\na");
  });

  test("a blank line lands at the depth of the block that FOLLOWS it — shallower", () => {
    // The empty paragraph is written as the last child of the bullet, and comes
    // back at root, beside it: a blank line carries no indent of its own, so the
    // block after it decides. This is the accepted loss, pinned so it stays a
    // known outcome (`research/2026-09-01-page-blank-line-empty-paragraph.md`).
    const forest = parse("- Bullet\n  - Nested\n\nNext");
    expect(forest.map((b) => b.type)).toEqual([
      "bulleted-list",
      "text",
      "text",
    ]);
    expect(forest.map(dataText)).toEqual(["Bullet", "", "Next"]);
    expect(forest[0]!.children.map(dataText)).toEqual(["Nested"]);
  });

  test("a blank line lands at the depth of the block that FOLLOWS it — deeper", () => {
    const forest = parse("- Bullet\n\n  - Nested");
    expect(forest).toHaveLength(1);
    expect(forest[0]!.children.map((b) => b.type)).toEqual([
      "text",
      "bulleted-list",
    ]);
    expect(forest[0]!.children.map(dataText)).toEqual(["", "Nested"]);
  });

  test("a leading and a trailing blank run are dropped", () => {
    // Nothing before them to be a sibling of, nothing after them to take a depth
    // from. On an apply that is an ordinary delete of a block owning nothing.
    expect(parse("\n\na\n\n\n")).toEqual([node("text", { text: runs("a") })]);
  });

  test("a blank run at the edge of a CONTAINER body is dropped too", () => {
    // A tag body recurses through the same parse, so "leading" and "trailing"
    // are per scope — the blank beside `a` inside the quote is an edge of that
    // body, not of the document.
    expect(parse("<quote>\n\n  a\n\n</quote>\nafter")).toEqual([
      {
        type: "quote",
        data: {},
        expanded: true,
        children: [node("text", { text: runs("a") })],
      },
      node("text", { text: runs("after") }),
    ]);
  });

  test("an empty paragraph between two container children survives", () => {
    const forest = [
      {
        type: "quote",
        data: {},
        expanded: true,
        children: [
          node("text", { text: runs("a") }),
          empty(),
          node("text", { text: runs("b") }),
        ],
      },
    ];
    expect(serialize(forest)).toBe("<quote>\n  a\n\n  b\n</quote>");
    expect(parse(serialize(forest))).toEqual(forest);
  });

  test("a nested empty paragraph emits an EMPTY line, never padded whitespace", () => {
    // Trailing whitespace is stripped in transit and reads as noise in a diff.
    const md = serialize([
      {
        ...node("text", { text: runs("parent") }),
        children: [
          node("text", { text: runs("a") }),
          empty(),
          node("text", { text: runs("b") }),
        ],
      },
    ]);
    expect(md).toBe("parent\n  a\n\n  b");
  });
});

describe("tag leniency: an unregistered or malformed tag is prose", () => {
  test("an unknown tag name stays text", () => {
    const forest = parse("<div>hello</div>");
    expect(forest[0]!.type).toBe("text");
    expect(dataText(forest[0]!)).toBe("<div>hello</div>");
  });

  test("an UNTERMINATED registered tag stays text rather than swallowing the document", () => {
    // The claim is DECLINED (there is no `</human>`), so the line falls
    // through to prose and the indented lines nest under it as ordinary
    // indentation would — never a container that runs to the end of the file.
    const forest = parse("<human>\n  a\n  b");
    expect(forest).toHaveLength(1);
    expect(forest[0]!.type).toBe("text");
    expect(dataText(forest[0]!)).toBe("<human>");
    expect(forest[0]!.children.map(dataText)).toEqual(["a", "b"]);
  });

  test("a paragraph that genuinely begins with `<` is escaped on the way out", () => {
    const forest = [node("text", { text: runs("<human> is a tag") })];
    expect(serialize(forest)).toBe("\\<human> is a tag");
    expect(parse(serialize(forest))).toEqual(forest);
  });
});

// ---------------------------------------------------------------------------
// The round-trip property: markdown is a LOSSLESS PROJECTION of the forest
// ---------------------------------------------------------------------------
//
// `parse(serialize(forest)) ≡ forest`, structurally, over a fuzzed forest. This
// is the assertion that actually encodes the goal — the one that would have
// caught the fence-indentation drift, and the one a NEW block type has to keep
// passing. Two deliberate exclusions, both stated as their own tests above:
//
//  - `page`, which is asymmetric BY DESIGN (it serializes, `page-link` parses);
//  - `expanded: false`, since markdown ignores the fold and every creation path
//    mints `expanded: true` ("a block is born expanded").

describe("round-trip property (fuzzed forest)", () => {
  /** Mulberry32 — deterministic, so a failure is reproducible from its seed. */
  const rng = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // Every line the REAL registry says it takes away from plain prose: each
  // hand-written claimer's declared samples (`markdown.parseLine.claims`), plus
  // `prefix + "x"` for every `markdownPrefixes` entry — a prefix IS its own
  // declaration, so it needs no second one.
  //
  // This is where the generator's alphabet comes from now, and it is the whole
  // point of this pass. It used to come from a word list chosen so that no
  // generated paragraph COULD open with a block marker, under a comment calling
  // that "a genuine lossiness of markdown itself". That premise was the bug:
  // CommonMark spells a literal marker with one leading backslash, the
  // serializer writes that now, and the property could never see any of it
  // because the fuzzer was built never to emit a line anybody would claim.
  const CLAIM_LINES: readonly string[] = [
    ...new Set(
      handles.flatMap((h) => [
        ...(h.markdown?.parseLine?.claims ?? []),
        ...(h.markdown?.lineRun?.claims ?? []),
        ...(h.markdownPrefixes ?? []).map((prefix) => prefix + "x"),
      ]),
    ),
  ];

  test("every declared claim line really IS claimed — no stale alphabet", () => {
    // Asserted before anything is generated from it. A sample that stopped
    // being claimed would quietly turn every paragraph built from it into an
    // ordinary one: the escape would have nothing to fire on, and the property
    // below would keep passing while testing nothing.
    expect(CLAIM_LINES.length).toBeGreaterThan(10);
    for (const line of CLAIM_LINES) {
      expect({ line, claimed: markdownLineClaim(line, mdCtx) !== undefined }) //
        .toEqual({ line, claimed: true });
    }
  });

  // Ordinary prose, and it no longer has to dodge anything — `pick` opens
  // roughly one text in four with a `CLAIM_LINES` entry instead.
  //
  // What the list still avoids is a soft break at a word's START or END.
  // `hoistBoundaryWhitespace` trims with `trimStart`/`trimEnd`, which treat
  // `\n` as whitespace, so a MARKED run ending in a break canonicalizes to a
  // bold run plus a bare one — a legitimate canonical-form rewrite (pinned in
  // `inline-markdown.test.ts`), not a defect, and this property asserts the
  // EXACT round trip. Hence one word with an INTERIOR break and no bare `"\n"`
  // entry, and no word starting with a space.
  //
  // The old list also excluded `[ ] ` and `* `, under the same heading, and
  // that half was simply FALSE. `[`, `]` and `*` are inline escape spellings,
  // so by the time a line exists they read `\[`, `\]` and `\*` and no claimer
  // can reach the line's first character. They were never claimable and never
  // lossy.
  const words = [
    "alpha",
    "bravo",
    "charlie",
    "delta*star",
    "echo_under",
    "foxtrot<lt",
    "golf\nhotel",
  ];

  /**
   * The callout's real colour set, READ OFF its registered schema rather than
   * copied into this file. A colour is not a block TYPE, so the coverage
   * assertion below would never notice a sixth one — reading the enum is what
   * stops this generator drifting the way the hand-written copy did, which knew
   * two of the five.
   */
  const CALLOUT_COLORS: readonly string[] = (() => {
    const color = (
      byType("callout").schema as unknown as {
        shape: Record<
          string,
          { removeDefault?: () => { options?: readonly string[] } } | undefined
        >;
      }
    ).shape.color;
    const options = color?.removeDefault?.().options;
    if (!options?.length) {
      throw new Error(
        "page/callout no longer declares `color` as a defaulted enum, so the " +
          "round-trip generator cannot read its colour set off the schema.",
      );
    }
    return options;
  })();

  const gens: {
    type: string;
    data(r: () => number): unknown;
    children: boolean;
  }[] = [
    { type: "text", data: (r) => ({ text: pick(r) }), children: true },
    // A paragraph that ALWAYS opens with a line another type would claim — the
    // shape the escape exists for, and precisely the one the old word list was
    // built to make impossible. `pick` reaches it about one text in four, which
    // over the whole corpus came out at thirteen lines; this entry makes it a
    // first-class member so the non-vacuity count below is a real sample rather
    // than a handful of accidents.
    { type: "text", data: (r) => ({ text: claimOpening(r) }), children: true },
    // An empty paragraph is a BLANK LINE where one can state its position, and
    // the handle's `<text/>` tag where one cannot (first, last, or carrying
    // children — see the pin in `describe("empty paragraphs")`). So it may own
    // children here, and the property below asserts the EXACT round trip over
    // every position the generator can produce, with no narrowing.
    { type: "text", data: () => ({ text: [] }), children: true },
    // Three soft-break shapes the word list cannot reach, each canonical and
    // each a real row on main. `pick` joins words with spaces and marks them
    // 40% of the time, so the interior break above already covers a break inside
    // a marked run, inside an unmarked one, in every text-bearing type and in
    // the `prompt` tag body — these are the ones it cannot produce.
    //
    // A run that is ONLY a break: the shape the empty-block pin used to claim
    // (`line.trim() === ""`) and delete outright.
    { type: "text", data: () => ({ text: [{ text: "\n" }] }), children: true },
    // A TRAILING break, unmarked so the hoist has nothing to rewrite — what a
    // `<p>a</p><p></p>` paste leaves behind.
    {
      type: "text",
      data: () => ({ text: [{ text: "india\n" }] }),
      children: true,
    },
    // The three-run `[bold "a"][break][bold "b"]` shape `walkNode` actually
    // produces for a marked line split by Shift+Enter: the break is its own
    // unmarked run, so `coalesce` cannot merge it into either neighbour.
    {
      type: "text",
      data: () => ({
        text: [
          { text: "juliett", marks: ["bold" as const] },
          { text: "\n" },
          { text: "kilo", marks: ["bold" as const] },
        ],
      }),
      children: true,
    },
    { type: "bulleted-list", data: (r) => ({ text: pick(r) }), children: true },
    { type: "heading-1", data: (r) => ({ text: pick(r) }), children: true },
    { type: "heading-2", data: (r) => ({ text: pick(r) }), children: true },
    { type: "heading-3", data: (r) => ({ text: pick(r) }), children: true },
    { type: "numbered-list", data: (r) => ({ text: pick(r) }), children: true },
    { type: "toggle", data: (r) => ({ text: pick(r) }), children: true },
    { type: "quote", data: () => ({}), children: true },
    { type: "prompt", data: (r) => ({ text: pick(r) }), children: true },
    {
      type: "to-do",
      data: (r) => ({ text: pick(r), checked: r() < 0.5 }),
      children: true,
    },
    { type: "divider", data: () => ({}), children: true },
    {
      type: "code-block",
      data: (r) => ({
        code: `const x = ${Math.floor(r() * 100)};\nreturn x;`,
        ...(r() < 0.5 ? { language: "ts" } : {}),
      }),
      children: true,
    },
    {
      type: "equation",
      data: (r) => ({ expression: `x^${Math.floor(r() * 9)}` }),
      children: true,
    },
    {
      type: "callout",
      data: (r) => ({
        icon: r() < 0.5 ? null : "info",
        color: CALLOUT_COLORS[Math.floor(r() * CALLOUT_COLORS.length)]!,
      }),
      children: true,
    },
    // The annotation family, under the names and tags the app really ships:
    // `<human>`, `<private-note>`, `<todo>`, `<instructions>` and the agent's
    // own `<agent-inline>`. The old copy of this suite had four of them under
    // invented types and tags, so what round-tripped here was a document
    // nothing ever writes.
    { type: "context", data: () => ({}), children: true },
    { type: "private-note", data: () => ({}), children: true },
    { type: "todo", data: () => ({}), children: true },
    // `global` is emitted ONLY when true, so `{global: false}` comes back `{}`
    // — a real, narrow round-trip loss in the instructions card, named here
    // rather than hidden by a generator that avoids the value by accident.
    {
      type: "instructions",
      data: (r) => (r() < 0.5 ? {} : { global: true }),
      children: true,
    },
    // Id-less here, which is the point: the fuzz forest exercises the OMIT
    // branch of the identified tag — a card with no row id still serializes,
    // and comes back with no `ref` key at all.
    { type: "agent-note", data: () => ({}), children: true },
    {
      type: "image",
      data: (r) => ({
        attachmentId: `att_${Math.floor(r() * 1000)}`,
        ...(r() < 0.5 ? { width: 320 + Math.floor(r() * 640) } : {}),
        ...(r() < 0.5 ? { alt: "a cat" } : {}),
      }),
      children: true,
    },
    {
      type: "video",
      data: (r) => ({ attachmentId: `v_${Math.floor(r() * 99)}` }),
      children: true,
    },
    {
      type: "audio",
      data: (r) => ({ attachmentId: `s_${Math.floor(r() * 99)}` }),
      children: true,
    },
    {
      type: "file",
      data: (r) => ({ filename: "notes.pdf", size: Math.floor(r() * 5000) }),
      children: true,
    },
    {
      type: "embed",
      data: () => ({ url: "https://example.com/e" }),
      children: true,
    },
    // `place` is the one type whose tag declares NON-STRING attributes of its
    // own: `lat`/`lng` as numbers, and the resolve stamp as an ISO 8601 date
    // rather than the epoch milliseconds the row stores. Both directions are
    // hand-written, so both are exercised — a fractional coordinate, a negative
    // one, and a timestamp with milliseconds on it.
    //
    // `children: false` for `page-link`'s reason: `body: "none"` self-closes,
    // so a child would be CONSUMED rather than emitted. A place is one object,
    // with no content of its own to nest under.
    {
      type: "place",
      data: (r) => ({
        providerId: "google",
        placeId: `pid_${Math.floor(r() * 999)}`,
        name: 'Caf\u00e9 "du coin"',
        address: "1 rue de la Paix",
        ...(r() < 0.5 ? { category: "Coffee shop" } : {}),
        ...(r() < 0.5 ? { mapsUrl: "https://maps.example/x" } : {}),
        ...(r() < 0.5
          ? { lat: 48.8566, lng: -2.3522 }
          : { lat: -33.8688, lng: 151.2093 }),
        ...(r() < 0.5 ? { fetchedAt: 1755518400123 } : {}),
      }),
      children: false,
    },
    // A GFM table: a LINE RUN, the one claim kind with no closing line. Cells
    // come from the same alphabet as every paragraph (so a cell can open with a
    // claimed line, hold a soft break or a mark), plus the three shapes only a
    // table cares about: a literal `|`, a cell reading as a delimiter cell, and
    // an empty one. Children allowed — a table's children nest below it by
    // indent, which is exactly the boundary the run collector must respect.
    {
      type: "table",
      data: (r) => {
        const width = 1 + Math.floor(r() * 3);
        const aligns = ["left", "center", "right", null] as const;
        const row = (): RichText[] =>
          Array.from({ length: width }, () => tableCell(r));
        return {
          align: Array.from(
            { length: width },
            () => aligns[Math.floor(r() * aligns.length)]!,
          ),
          header: row(),
          rows: Array.from({ length: Math.floor(r() * 3) }, row),
        };
      },
      children: true,
    },
    {
      type: "bookmark",
      data: (r) => ({
        url: "https://example.com",
        ...(r() < 0.5 ? { title: 'a "quoted" title' } : {}),
        ...(r() < 0.5 ? { fetched: true } : {}),
        ...(r() < 0.5 ? { attachmentIds: ["i1", "f1"] } : {}),
      }),
      children: true,
    },
    // `page-link` is a POINTER: its body is `"none"`, so it never carries
    // children (they belong to the page it points at, not to this document).
    {
      type: "page-link",
      data: (r) => ({ pageId: `p${Math.floor(r() * 99)}` }),
      children: false,
    },
    // `<map/>`: empty data (what it shows is derived from the page's places on
    // render), and `body: "none"` like `page-link`, so no children.
    { type: "map", data: () => ({}), children: false },
    // An AGENT-AUTHORED page — the one `page` a document can carry both ways.
    // Id-less below, it is the MINT form (`<agent-page title="…">body`); stamped,
    // it is the pointer plus body, and its id comes back as `ref` because
    // `<agent-page>` is an identified spelling. A HUMAN's page is absent on
    // purpose: `<page>` parses as a link, so it cannot round-trip here at all.
    {
      type: "page",
      data: (r) => ({
        title: `${words[Math.floor(r() * words.length)]!} "notes"`,
        icon: null,
        author: "agent" as const,
      }),
      children: true,
    },
  ];

  /**
   * A run opening with a declared claim line, and nothing before it. Only the
   * DEFAULT-TEXT type can ever be escaped — every other type emits its own
   * prefix first, so its line is claimed by itself — which is why this shape
   * only means anything on a `text` block.
   */
  function claimOpening(r: () => number): RichText {
    const claim = CLAIM_LINES[Math.floor(r() * CLAIM_LINES.length)]!;
    const body = words[Math.floor(r() * words.length)]!;
    return [{ text: r() < 0.3 ? claim : claim + " " + body }];
  }

  /** One table cell: a paragraph's text, or one of the table-only shapes. */
  function tableCell(r: () => number): RichText {
    const roll = r();
    if (roll < 0.15) return [];
    if (roll < 0.3) {
      const w = words[Math.floor(r() * words.length)]!;
      return [{ text: r() < 0.5 ? `${w}|${w}` : `| ${w} |` }];
    }
    if (roll < 0.38) return [{ text: r() < 0.5 ? "---" : ":-:" }];
    return pick(r);
  }

  function pick(r: () => number): RichText {
    // One text in four OPENS with a line another block type would claim. Both
    // halves of that are load-bearing:
    //
    //  - FIRST, because a claimer anchors at the line's start (or compares its
    //    `trim()`), so a marker anywhere else is just words;
    //  - UNMARKED, because the mark's own delimiters would be there first —
    //    `**3. x**` is claimed by nobody, and a generator that marked the claim
    //    would exercise the escape exactly as often as the old word list did.
    const claim =
      r() < 0.25
        ? CLAIM_LINES[Math.floor(r() * CLAIM_LINES.length)]!
        : undefined;
    const n = 1 + Math.floor(r() * 3);
    const parts: string[] = [];
    for (let i = 0; i < n; i++)
      parts.push(words[Math.floor(r() * words.length)]!);
    const marks =
      r() < 0.25
        ? ["bold" as const]
        : r() < 0.4
          ? ["italic" as const]
          : undefined;
    const body = parts.join(" ");
    if (claim === undefined)
      return [{ text: body, ...(marks ? { marks } : {}) }];
    // With marks the claim is its own leading run; without them it has to be
    // the SAME run as the words, or the parse coalesces two adjacent unmarked
    // runs back into one and the exact round trip would fail on a rewrite this
    // property is not about. Sometimes it is the whole text, which is the only
    // way to reach a claimer that reads the whole line (`divider` compares
    // `trim() === "---"`, so `--- alpha` is prose).
    if (marks) return [{ text: claim + " " }, { text: body, marks }];
    return [{ text: r() < 0.5 ? claim : claim + " " + body }];
  }

  const build = (r: () => number, depth: number): SerializedBlock => {
    const gen = gens[Math.floor(r() * gens.length)]!;
    const kids: SerializedBlock[] = [];
    if (gen.children && depth < 3) {
      const n = Math.floor(r() * (depth === 0 ? 3 : 2));
      for (let i = 0; i < n; i++) kids.push(build(r, depth + 1));
    }
    return {
      type: gen.type,
      data: gen.data(r),
      expanded: true,
      children: kids,
    };
  };

  test("the generator covers EVERY registered block type", () => {
    // The one thing a fuzzer cannot tell you is what it never generated. With
    // the registry right here, a 29th block type arrives as a failing test
    // rather than as silence — which is the other half of running on the real
    // handles, since loading them proves nothing if the generator ignores half.
    expect([...new Set(gens.map((g) => g.type))].sort()).toEqual(
      handles.map((h) => h.type).sort(),
    );
  });

  test("the corpus really contains escaped lines — the alphabet is not vacuous", () => {
    // The assertion this whole pass exists for. If the generator ever stops
    // producing paragraphs that open like a list, the property below keeps
    // passing and says nothing at all about the escape — which is exactly how
    // the line-claim loss survived a fuzzed round-trip property for months.
    //
    // A line-claim escape is a backslash at the line's start whose NEXT
    // character is not one of the nine the inline table spells (the ESCAPES
    // table in `inline-markdown.ts`). Excluding all nine makes this a LOWER
    // bound — a paragraph reading "* x" is line-claim escaped too and is not
    // counted here — and a lower bound is the safe direction for a count whose
    // job is to catch zero.
    const inlineSpellings = new Set([
      "\\",
      "*",
      "_",
      "~",
      "`",
      "[",
      "]",
      "<",
      "n",
    ]);
    let escaped = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const forest: SerializedBlock[] = [];
      const roots = 1 + Math.floor(r() * 4);
      for (let i = 0; i < roots; i++) forest.push(build(r, 0));
      for (const line of serialize(forest).split("\n")) {
        const escape = /^\s*\\(.)/.exec(line);
        if (escape && !inlineSpellings.has(escape[1]!)) escaped++;
      }
    }
    expect(escaped).toBeGreaterThan(50);
  });

  test("one backslash defeats EVERY claimer, over every string of length <= 4", () => {
    // The statement the declared samples cannot make. A sample proves the
    // escape on the line somebody remembered to write down; this proves it over
    // a COMPUTED set — every string up to four characters long built from the
    // characters the claims are themselves made of, plus a space, a digit and a
    // letter. ~89k probes, each a handful of anchored regexes.
    //
    // One `expect` at the end rather than one per probe: 89k assertions cost
    // more than the probes do, and a list of counterexamples reads better than
    // the first one.
    const alphabet = [...new Set([...CLAIM_LINES.join(""), " ", "2", "a"])];
    const stillClaimed: string[] = [];
    let probes = 0;
    const sweep = (s: string): void => {
      probes++;
      if (markdownLineClaim("\\" + s, mdCtx) !== undefined)
        stillClaimed.push(s);
      if (s.length === 4) return;
      for (const c of alphabet) sweep(s + c);
    };
    sweep("");
    expect(stillClaimed).toEqual([]);
    expect(probes).toBeGreaterThan(50_000);
  });

  test("parse(serialize(forest)) === forest, over 400 seeds", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const generated: SerializedBlock[] = [];
      const roots = 1 + Math.floor(r() * 4);
      for (let i = 0; i < roots; i++) generated.push(build(r, 0));
      // No narrowing: every empty paragraph the generator places round-trips,
      // because the pin spells the three positions a blank line cannot state.
      const forest = generated;
      const md = serialize(forest);
      expect({ seed, forest: parse(md) }).toEqual({ seed, forest });
      // Idempotence: the emitted document is CANONICAL, so a second cycle is a
      // fixed point (the property the fence-indent bug broke).
      expect({ seed, md: serialize(parse(md)) }).toEqual({ seed, md });
    }
  });

  // -------------------------------------------------------------------------
  // The identified-tag property: every id survives, and ONLY as a `ref`
  // -------------------------------------------------------------------------
  //
  // The property above runs over an id-less forest, which proves the OMIT
  // branch. This one stamps a distinct id onto every node — the shape a real
  // read hands the serializer — and asserts the round trip is the identity map
  // plus exactly one thing: each identified node's `ref` is the id it was
  // serialized from. Everything else, identified nodes' own `data` and children
  // included, is byte-for-byte the same forest.
  //
  // The identified TYPE SET comes from the registry, never a literal — the same
  // derivation `markdown-apply` makes, so this property keeps holding when a new
  // type opts in.

  test("a stamped forest round-trips its ids as `ref` on identified nodes, over 200 seeds", () => {
    const identifiedTypes = new Set(
      handles.filter(markdownTagIsIdentified).map((h) => h.type),
    );
    // Non-vacuity: an empty set would make every assertion below trivially true.
    expect(identifiedTypes.size).toBeGreaterThan(0);

    /** Stamp a distinct id onto every node — path-derived, so it is readable. */
    const stamp = (nodes: SerializedBlock[], prefix: string): MarkdownNode[] =>
      nodes.map((n, i) => ({
        ...n,
        id: `block-${prefix}${i}`,
        children: stamp(n.children, `${prefix}${i}.`),
      }));

    /** The same forest, with a `ref` exactly where an identified tag carried one. */
    const expected = (nodes: MarkdownNode[]): SerializedBlock[] =>
      nodes.map((n) => ({
        type: n.type,
        data: n.data,
        expanded: true,
        children: expected(n.children),
        ...(identifiedTypes.has(n.type) ? { ref: n.id } : {}),
      }));

    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const generated: SerializedBlock[] = [];
      const roots = 1 + Math.floor(r() * 4);
      for (let i = 0; i < roots; i++) generated.push(build(r, 0));
      const stamped = stamp(generated, "");
      const parsed = parseMarkdownToForest(
        serializeForestToMarkdown(stamped, mdCtx),
        mdCtx,
      );
      expect({ seed, forest: parsed }).toEqual({
        seed,
        forest: expected(stamped),
      });
    }
  });
});
