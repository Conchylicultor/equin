import { describe, expect, test } from "vitest";
import { buildSegments, maskCode } from "../internal/segment-active-data";

const Go = () => null;
const contribs = [
  { display: "block", tag: "go", inline: Go, component: Go },
] as unknown as Parameters<typeof buildSegments>[1];

describe("maskCode", () => {
  test("blanks code spans and fences, keeping length and line breaks", () => {
    const text = "a `</go>` b\n```\n<go>\n```\nc";
    const masked = maskCode(text);
    expect(masked).toHaveLength(text.length);
    expect(masked).toBe("a         b\n   \n    \n   \nc");
  });
});

describe("buildSegments", () => {
  test("a close tag written as code does not end the block", () => {
    const text = [
      "Which?",
      "",
      "<go>",
      "- [ ] Drop the `<go>` marker",
      "- [ ] Keep the stray `</go>`",
      "</go>",
    ].join("\n");
    const segments = buildSegments(text, contribs);
    expect(segments.map((s) => s.type)).toEqual(["markdown", "block"]);
    expect(segments[1]).toMatchObject({
      content: "- [ ] Drop the `<go>` marker\n- [ ] Keep the stray `</go>`",
    });
  });

  test("a tag inside a fenced block stays markdown", () => {
    const text = "```\n<go>\n- [ ] x\n</go>\n```";
    expect(buildSegments(text, contribs)).toEqual([{ type: "markdown", text }]);
  });

  test("one line in block form is a block; on the open tag's line it is inline", () => {
    expect(
      buildSegments("<go>\n- [ ] Only one\n</go>", contribs).map((s) => s.type),
    ).toEqual(["block"]);
    expect(
      buildSegments("<go>\n- [x] Only one</go>", contribs).map((s) => s.type),
    ).toEqual(["block"]);
    expect(buildSegments("<go>Implement it</go>", contribs)).toEqual([
      { type: "markdown", text: "<go>Implement it</go>" },
    ]);
  });

  test("block form opened at the end of a prose line is a block after that prose", () => {
    const text = [
      "Want me to file any of these? <go>",
      "- [x] A",
      "- [ ] B",
      "</go>",
    ].join("\n");
    expect(buildSegments(text, contribs)).toMatchObject([
      { type: "markdown", text: "Want me to file any of these? " },
      { type: "block", tag: "go", content: "- [x] A\n- [ ] B" },
    ]);
  });
});
