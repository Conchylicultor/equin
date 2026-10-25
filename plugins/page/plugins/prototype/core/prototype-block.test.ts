import { describe, expect, test } from "bun:test";
import { prototypeBlock } from "./prototype-block";

const tag = prototypeBlock.markdown!.tag!;
type SerializeCtx = Parameters<NonNullable<typeof tag.attrs>>[1];
type ParseCtx = Parameters<NonNullable<typeof tag.parseAttrs>>[1];
const serializeCtx: SerializeCtx = {
  md: (t) => String(t),
  mdLine: (t) => String(t),
  protectedSpans: [],
  plain: (t) => String(t),
  ordinal: 0,
};
const parseCtx: ParseCtx = { runs: () => [], protectedSpans: [] };

describe("prototype markdown tag", () => {
  test("the id survives a round trip", () => {
    const data = { prototypeId: "proto-1792943162-9edlda" };
    const attrs = tag.attrs!(data, serializeCtx) as Record<string, string>;
    expect(attrs).toEqual({ id: "proto-1792943162-9edlda" });
    expect(tag.parseAttrs!(attrs, parseCtx)).toEqual(data);
  });

  test("a missing id is refused", () => {
    expect(() => tag.parseAttrs!({}, parseCtx)).toThrow(/needs an `id`/);
  });

  test("an id that is not a prototype's is refused", () => {
    expect(() => tag.parseAttrs!({ id: "block-123" }, parseCtx)).toThrow(
      /must be a prototype id/,
    );
  });
});
