import { describe, expect, test } from "bun:test";
import {
  decideTransfer,
  decodeBlocksPayload,
  encodeBlocksPayload,
  readTransferText,
  type TransferDecision,
} from "./transfer";

describe("decideTransfer", () => {
  // One table, because the rule IS a table: the four inputs and the arm each
  // combination resolves to. A case added here reads as a row of the rule
  // rather than as a fifth near-identical test body.
  const cases: {
    name: string;
    opts: Parameters<typeof decideTransfer>[0];
    expected: TransferDecision;
  }[] = [
    {
      name: "a file wins over a forest and over text",
      opts: {
        isFile: true,
        blocksJson: '[{"type":"page.text"}]',
        text: "a\nb",
        inline: true,
      },
      expected: { kind: "file" },
    },
    {
      name: "a BLOCKS_MIME payload beats text",
      opts: {
        isFile: false,
        blocksJson: '[{"type":"page.text"}]',
        text: "hi",
        inline: true,
      },
      expected: { kind: "forest", json: '[{"type":"page.text"}]' },
    },
    {
      name: "a single line with an insertion point stays inline",
      opts: {
        isFile: false,
        blocksJson: "",
        text: "just one line",
        inline: true,
      },
      expected: { kind: "inline" },
    },
    {
      name: "a single line with NO insertion point becomes blocks",
      opts: {
        isFile: false,
        blocksJson: "",
        text: "just one line",
        inline: false,
      },
      expected: { kind: "markdown", text: "just one line" },
    },
    {
      name: "multi-line text becomes blocks even with an insertion point",
      opts: { isFile: false, blocksJson: "", text: "# H\n- a", inline: true },
      expected: { kind: "markdown", text: "# H\n- a" },
    },
    {
      // The user's case: a single paragraph copied with its line terminator is
      // NOT inline — it goes to the forest door, which splices it into the
      // caret's own line (a head-only splice), rather than being classified by
      // how many paragraphs it parses to.
      name: "a lone line WITH its terminator goes to the forest door",
      opts: {
        isFile: false,
        blocksJson: "",
        text: "The plugin system\n",
        inline: true,
      },
      expected: { kind: "markdown", text: "The plugin system\n" },
    },
    {
      name: "a CRLF newline counts as a newline",
      opts: { isFile: false, blocksJson: "", text: "one\r\ntwo", inline: true },
      expected: { kind: "markdown", text: "one\r\ntwo" },
    },
    {
      name: "empty text with an insertion point stays inline",
      opts: { isFile: false, blocksJson: "", text: "", inline: true },
      expected: { kind: "inline" },
    },
    {
      // Not a special case: emptiness is handled once, at the call site's
      // "an empty parsed forest declines" check.
      name: "empty text with no insertion point falls through to markdown",
      opts: { isFile: false, blocksJson: "", text: "", inline: false },
      expected: { kind: "markdown", text: "" },
    },
  ];

  for (const { name, opts, expected } of cases) {
    test(name, () => expect(decideTransfer(opts)).toEqual(expected));
  }
});

/** The two MIME reads `readTransferText` chooses between, nothing else. */
function fakeTransfer(data: Record<string, string>): DataTransfer {
  return { getData: (type: string) => data[type] ?? "" } as DataTransfer;
}

describe("readTransferText", () => {
  test("reads text/plain when present", () => {
    expect(
      readTransferText(
        fakeTransfer({ "text/plain": "plain", "text/uri-list": "https://x" }),
      ),
    ).toBe("plain");
  });

  test("falls back to text/uri-list when text/plain is absent", () => {
    expect(
      readTransferText(fakeTransfer({ "text/uri-list": "https://x" })),
    ).toBe("https://x");
  });

  test("falls back on an EMPTY text/plain too, as Lexical's own read does", () => {
    expect(
      readTransferText(
        fakeTransfer({ "text/plain": "", "text/uri-list": "https://x" }),
      ),
    ).toBe("https://x");
  });

  test("no text at all reads as the empty string", () => {
    expect(readTransferText(fakeTransfer({}))).toBe("");
  });
});

describe("the BLOCKS_MIME payload envelope", () => {
  const forest = [
    { type: "page.text", data: { text: [] }, expanded: true, children: [] },
  ];

  test("what we write round-trips as whole blocks", () => {
    expect(decodeBlocksPayload(encodeBlocksPayload(forest, "blocks"))).toEqual({
      ok: true,
      granularity: "blocks",
      forest,
    });
  });

  test("a pre-envelope bare array reads as whole blocks — every such payload was one", () => {
    expect(decodeBlocksPayload(JSON.stringify(forest))).toEqual({
      ok: true,
      granularity: "blocks",
      forest,
    });
  });

  test("an envelope stating text granularity is kept as text", () => {
    expect(
      decodeBlocksPayload(JSON.stringify({ granularity: "text", forest })),
    ).toEqual({ ok: true, granularity: "text", forest });
  });

  test("malformed JSON and unknown shapes are not our payload", () => {
    expect(decodeBlocksPayload("{not json")).toEqual({ ok: false });
    expect(decodeBlocksPayload('"a string"')).toEqual({ ok: false });
    expect(
      decodeBlocksPayload(JSON.stringify({ granularity: "lines", forest })),
    ).toEqual({ ok: false });
    expect(
      decodeBlocksPayload(JSON.stringify({ granularity: "blocks" })),
    ).toEqual({ ok: false });
  });
});
